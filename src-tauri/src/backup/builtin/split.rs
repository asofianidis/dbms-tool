//! Splits a SQL script into statements as it streams in, the way psql and the
//! mysql client do: quotes, comments and dollar quotes hide semicolons, COPY …
//! FROM stdin is followed by its data, backslash commands stand alone,
//! PostgreSQL's BEGIN ATOMIC function bodies keep their semicolons, and
//! MySQL's DELIMITER changes what ends a statement. In PostgreSQL a `;` inside
//! parentheses doesn't end one either (pg_dump's multi-action rules), and in
//! MySQL backslashes stop escaping while sql_mode has NO_BACKSLASH_ESCAPES.
//!
//! It works on bytes: everything it looks for is ASCII, and mysqldump writes
//! binary values as raw bytes inside string literals, which must pass through
//! untouched.

use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    Postgres,
    Mysql,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Item {
    Statement(Vec<u8>),
    /// `COPY … FROM stdin`; `CopyData` lines follow until `CopyEnd`
    CopyStart(String),
    CopyData(Vec<u8>),
    CopyEnd,
    /// A psql backslash command (`\connect db`), without its line break
    Meta(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum State {
    Normal,
    /// Inside '…'; `backslash` for E'…' and MySQL strings
    Single {
        backslash: bool,
    },
    /// Inside "…" (an identifier in PostgreSQL, a string in MySQL)
    Double {
        backslash: bool,
    },
    Backtick,
    LineComment,
    /// Nesting depth (PostgreSQL nests block comments)
    Block {
        depth: u32,
    },
    Dollar(Vec<u8>),
}

pub struct Splitter {
    dialect: Dialect,
    state: State,
    buf: Vec<u8>,
    /// Something other than whitespace and comments is in `buf`
    content: bool,
    delimiter: Vec<u8>,
    copying: bool,
    /// The statement's first words, lowercased, to spot CREATE FUNCTION
    head: Vec<Vec<u8>>,
    /// BEGIN (ATOMIC) and CASE blocks open in a CREATE FUNCTION or
    /// PROCEDURE, whose semicolons don't end it (as psql counts them)
    begin_depth: u32,
    /// Parentheses open in a PostgreSQL statement, as psql counts them
    paren_depth: u32,
    /// MySQL's sql_mode has NO_BACKSLASH_ESCAPES, so backslashes are literal
    no_backslash_escapes: bool,
    /// Whether NO_BACKSLASH_ESCAPES was on when `@var = @@sql_mode` saved it
    saved_modes: HashMap<Vec<u8>, bool>,
}

impl Splitter {
    pub fn new(dialect: Dialect) -> Self {
        Self {
            dialect,
            state: State::Normal,
            buf: Vec::new(),
            content: false,
            delimiter: b";".to_vec(),
            copying: false,
            head: Vec::new(),
            begin_depth: 0,
            paren_depth: 0,
            no_backslash_escapes: false,
            saved_modes: HashMap::new(),
        }
    }

    /// Feeds one line, line break included, and returns what it completed.
    pub fn push(&mut self, line: &[u8]) -> Vec<Item> {
        if self.copying {
            if trim_eol(line) == b"\\." {
                self.copying = false;
                return vec![Item::CopyEnd];
            }
            return vec![Item::CopyData(line.to_vec())];
        }
        if self.state == State::Normal && !self.content {
            let trimmed = line.trim_ascii();
            if self.dialect == Dialect::Postgres && trimmed.starts_with(b"\\") {
                self.buf.clear();
                return vec![Item::Meta(String::from_utf8_lossy(trimmed).into_owned())];
            }
            if self.dialect == Dialect::Mysql
                && let Some(rest) = strip_keyword(trimmed, b"delimiter")
            {
                let delimiter = rest
                    .trim_ascii()
                    .split(|b| b.is_ascii_whitespace())
                    .next()
                    .filter(|d| !d.is_empty())
                    .unwrap_or(b";");
                self.delimiter = delimiter.to_vec();
                self.buf.clear();
                return Vec::new();
            }
        }

        let mut items = Vec::new();
        let mut i = 0;
        while i < line.len() {
            let c = line[i];
            let next = line.get(i + 1).copied();
            match self.state.clone() {
                State::Normal => {
                    if line[i..].starts_with(&self.delimiter)
                        && self.begin_depth == 0
                        && self.paren_depth == 0
                    {
                        if self.content {
                            items.push(self.finish_statement());
                        } else {
                            self.buf.clear();
                        }
                        i += self.delimiter.len();
                        if self.copying {
                            // Anything after `;` on the COPY line is the first data line
                            let rest = &line[i..];
                            if !rest.trim_ascii().is_empty() {
                                items.extend(self.push(rest));
                            }
                            return items;
                        }
                        continue;
                    }
                    match c {
                        b'\'' => {
                            let backslash = self.mysql_backslash()
                                || (self.dialect == Dialect::Postgres
                                    && i > 0
                                    && matches!(line[i - 1], b'E' | b'e')
                                    && (i < 2 || !is_ident(line[i - 2])));
                            self.state = State::Single { backslash };
                            self.content = true;
                        }
                        b'"' => {
                            self.state = State::Double {
                                backslash: self.mysql_backslash(),
                            };
                            self.content = true;
                        }
                        b'`' if self.dialect == Dialect::Mysql => {
                            self.state = State::Backtick;
                            self.content = true;
                        }
                        b'-' if next == Some(b'-')
                            && (self.dialect == Dialect::Postgres
                                || line.get(i + 2).is_none_or(|c| c.is_ascii_whitespace())) =>
                        {
                            self.state = State::LineComment;
                        }
                        b'#' if self.dialect == Dialect::Mysql => self.state = State::LineComment,
                        b'/' if next == Some(b'*') => {
                            // MySQL runs what's in /*! … */, so it counts as content
                            if self.dialect == Dialect::Mysql && line.get(i + 2) == Some(&b'!') {
                                self.content = true;
                            }
                            self.state = State::Block { depth: 1 };
                            self.buf.extend_from_slice(b"/*");
                            i += 2;
                            continue;
                        }
                        b'$' if self.dialect == Dialect::Postgres
                            && (i == 0 || !is_ident(line[i - 1])) =>
                        {
                            if let Some(tag) = dollar_tag(&line[i + 1..]) {
                                let open = [b"$".as_slice(), &tag, b"$"].concat();
                                self.buf.extend_from_slice(&open);
                                i += open.len();
                                self.state = State::Dollar(open);
                                self.content = true;
                                continue;
                            }
                            self.content = true;
                        }
                        c if self.dialect == Dialect::Postgres
                            && (c.is_ascii_alphabetic() || c == b'_' || c >= 0x80)
                            && (i == 0 || !is_ident(line[i - 1])) =>
                        {
                            let end = line[i..]
                                .iter()
                                .position(|&b| !is_ident(b))
                                .map_or(line.len(), |n| i + n);
                            self.word(&line[i..end]);
                            self.buf.extend_from_slice(&line[i..end]);
                            self.content = true;
                            i = end;
                            continue;
                        }
                        b'(' if self.dialect == Dialect::Postgres => {
                            self.paren_depth += 1;
                            self.content = true;
                        }
                        b')' if self.dialect == Dialect::Postgres => {
                            self.paren_depth = self.paren_depth.saturating_sub(1);
                            self.content = true;
                        }
                        c if !c.is_ascii_whitespace() => self.content = true,
                        _ => {}
                    }
                    self.buf.push(c);
                }
                State::Single { backslash } | State::Double { backslash } => {
                    let quote = if matches!(self.state, State::Single { .. }) {
                        b'\''
                    } else {
                        b'"'
                    };
                    self.buf.push(c);
                    if backslash && c == b'\\' {
                        if let Some(n) = next {
                            self.buf.push(n);
                            i += 2;
                            continue;
                        }
                    } else if c == quote {
                        if next == Some(quote) {
                            self.buf.push(quote);
                            i += 2;
                            continue;
                        }
                        self.state = State::Normal;
                    }
                }
                State::Backtick => {
                    self.buf.push(c);
                    if c == b'`' {
                        if next == Some(b'`') {
                            self.buf.push(b'`');
                            i += 2;
                            continue;
                        }
                        self.state = State::Normal;
                    }
                }
                State::LineComment => {
                    self.buf.push(c);
                    if c == b'\n' {
                        self.state = State::Normal;
                    }
                }
                State::Block { depth } => {
                    if c == b'*' && next == Some(b'/') {
                        self.buf.extend_from_slice(b"*/");
                        i += 2;
                        self.state = if depth > 1 {
                            State::Block { depth: depth - 1 }
                        } else {
                            State::Normal
                        };
                        continue;
                    }
                    if c == b'/' && next == Some(b'*') && self.dialect == Dialect::Postgres {
                        self.buf.extend_from_slice(b"/*");
                        i += 2;
                        self.state = State::Block { depth: depth + 1 };
                        continue;
                    }
                    self.buf.push(c);
                }
                State::Dollar(close) => {
                    if line[i..].starts_with(&close) {
                        self.buf.extend_from_slice(&close);
                        i += close.len();
                        self.state = State::Normal;
                        continue;
                    }
                    self.buf.push(c);
                }
            }
            i += 1;
        }
        // A line comment ends with its line even without a line break
        if self.state == State::LineComment {
            self.state = State::Normal;
        }
        items
    }

    /// What's left at the end of the script: a last statement without its terminator.
    pub fn finish(&mut self) -> Option<Item> {
        if self.content && !self.copying {
            Some(self.finish_statement())
        } else {
            None
        }
    }

    /// Whether a MySQL string starting now treats backslashes as escapes.
    fn mysql_backslash(&self) -> bool {
        self.dialect == Dialect::Mysql && !self.no_backslash_escapes
    }

    /// Follows `SET sql_mode = …` (also inside `/*!50003 … */`, as mysqldump
    /// writes around routines), including saving it to a variable and back.
    fn track_sql_mode(&mut self, sql: &[u8]) {
        let Some(list) = strip_keyword(mysql_executed(sql), b"set") else {
            return;
        };
        for assignment in split_top_level(list, b',') {
            let Some(at) = assignment.iter().position(|&b| b == b'=') else {
                continue;
            };
            let lhs = assignment[..at].trim_ascii();
            let lhs = lhs.strip_suffix(b":").unwrap_or(lhs).trim_ascii();
            let rhs = assignment[at + 1..].trim_ascii();
            let rhs_lower = rhs.to_ascii_lowercase();
            if let Some(var) = user_variable(lhs) {
                if is_session_sql_mode(&rhs_lower) {
                    self.saved_modes.insert(var, self.no_backslash_escapes);
                }
                continue;
            }
            if !is_session_sql_mode(&lhs.to_ascii_lowercase()) {
                continue;
            }
            let mentions = rhs_lower.windows(20).any(|w| w == b"no_backslash_escapes");
            self.no_backslash_escapes = if let Some(var) = user_variable(rhs) {
                self.saved_modes.get(&var).copied().unwrap_or(false)
            } else if rhs.starts_with(b"'") || rhs.starts_with(b"\"") {
                mentions
            } else if rhs_lower == b"default" {
                false
            } else {
                // @@sql_mode itself, or an expression such as
                // CONCAT(@@sql_mode, ',NO_BACKSLASH_ESCAPES')
                mentions || self.no_backslash_escapes
            };
        }
    }

    /// Tracks BEGIN / CASE / END in a CREATE FUNCTION or PROCEDURE.
    fn word(&mut self, word: &[u8]) {
        let word = word.to_ascii_lowercase();
        if self.head.len() < 4 {
            self.head.push(word.clone());
        }
        let routine = match self.head.as_slice() {
            [create, kind, ..] if create == b"create" => {
                matches!(kind.as_slice(), b"function" | b"procedure")
                    || (kind == b"or"
                        && self
                            .head
                            .get(3)
                            .is_some_and(|k| matches!(k.as_slice(), b"function" | b"procedure")))
            }
            _ => false,
        };
        if !routine {
            return;
        }
        match word.as_slice() {
            b"begin" => self.begin_depth += 1,
            b"case" if self.begin_depth > 0 => self.begin_depth += 1,
            b"end" if self.begin_depth > 0 => self.begin_depth -= 1,
            _ => {}
        }
    }

    fn finish_statement(&mut self) -> Item {
        let sql = std::mem::take(&mut self.buf).trim_ascii().to_vec();
        self.content = false;
        self.head.clear();
        self.begin_depth = 0;
        self.paren_depth = 0;
        if self.dialect == Dialect::Mysql {
            self.track_sql_mode(&sql);
        }
        // pg_dump heads each COPY with a comment block
        let body = skip_comments(&sql);
        if self.dialect == Dialect::Postgres && is_copy_from_stdin(body) {
            self.copying = true;
            return Item::CopyStart(String::from_utf8_lossy(body).into_owned());
        }
        Item::Statement(sql)
    }
}

/// Identifier characters; bytes of multi-byte UTF-8 characters count as letters.
fn is_ident(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || c == b'$' || c >= 0x80
}

/// The tag of a dollar quote starting just after its first `$`: `$$` or `$tag$`.
fn dollar_tag(after: &[u8]) -> Option<Vec<u8>> {
    for (n, &c) in after.iter().enumerate() {
        if c == b'$' {
            return Some(after[..n].to_vec());
        }
        let ok = c == b'_' || c.is_ascii_alphabetic() || c >= 0x80 || (n > 0 && c.is_ascii_digit());
        if !ok {
            return None;
        }
    }
    None
}

fn trim_eol(line: &[u8]) -> &[u8] {
    let line = line.strip_suffix(b"\n").unwrap_or(line);
    line.strip_suffix(b"\r").unwrap_or(line)
}

/// What follows a leading keyword, matched case-insensitively and followed by whitespace.
fn strip_keyword<'a>(text: &'a [u8], keyword: &[u8]) -> Option<&'a [u8]> {
    let head = text.get(..keyword.len())?;
    let rest = &text[keyword.len()..];
    (head.eq_ignore_ascii_case(keyword) && rest.first().is_some_and(u8::is_ascii_whitespace))
        .then_some(rest)
}

/// `sql` after any leading whitespace, `--` comments and `/* */` comments.
fn skip_comments(mut sql: &[u8]) -> &[u8] {
    loop {
        sql = sql.trim_ascii_start();
        if sql.starts_with(b"--") {
            sql = sql
                .iter()
                .position(|&b| b == b'\n')
                .map_or(&[][..], |n| &sql[n + 1..]);
        } else if sql.starts_with(b"/*") {
            sql = sql
                .windows(2)
                .position(|w| w == b"*/")
                .map_or(&[][..], |n| &sql[n + 2..]);
        } else {
            return sql;
        }
    }
}

/// What MySQL runs of a statement: past leading comments, with a `/*!NNNNN … */`
/// wrapper taken off.
fn mysql_executed(mut sql: &[u8]) -> &[u8] {
    loop {
        sql = sql.trim_ascii_start();
        if sql.starts_with(b"--") || sql.starts_with(b"#") {
            sql = sql
                .iter()
                .position(|&b| b == b'\n')
                .map_or(&[][..], |n| &sql[n + 1..]);
        } else if let Some(rest) = sql.strip_prefix(b"/*!") {
            let rest = &rest[rest.iter().take_while(|b| b.is_ascii_digit()).count()..];
            let rest = rest.trim_ascii();
            return rest.strip_suffix(b"*/").unwrap_or(rest).trim_ascii();
        } else if sql.starts_with(b"/*") {
            sql = sql
                .windows(2)
                .position(|w| w == b"*/")
                .map_or(&[][..], |n| &sql[n + 2..]);
        } else {
            return sql.trim_ascii_end();
        }
    }
}

/// Splits at `sep` outside quotes and parentheses.
fn split_top_level(text: &[u8], sep: u8) -> Vec<&[u8]> {
    let mut parts = Vec::new();
    let mut quote = None;
    let mut depth = 0u32;
    let mut start = 0;
    for (i, &c) in text.iter().enumerate() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None => match c {
                b'\'' | b'"' | b'`' => quote = Some(c),
                b'(' => depth += 1,
                b')' => depth = depth.saturating_sub(1),
                c if c == sep && depth == 0 => {
                    parts.push(&text[start..i]);
                    start = i + 1;
                }
                _ => {}
            },
        }
    }
    parts.push(&text[start..]);
    parts
}

/// `@name` (not `@@`), lowercased and unquoted.
fn user_variable(text: &[u8]) -> Option<Vec<u8>> {
    let name = text.strip_prefix(b"@")?.trim_ascii();
    if name.is_empty() || name.starts_with(b"@") {
        return None;
    }
    let name = name
        .strip_prefix(b"`")
        .and_then(|n| n.strip_suffix(b"`"))
        .unwrap_or(name);
    Some(name.to_ascii_lowercase())
}

/// The session's sql_mode, written lowercased on either side of `=`.
fn is_session_sql_mode(lower: &[u8]) -> bool {
    let name = lower
        .strip_prefix(b"@@session.")
        .or_else(|| lower.strip_prefix(b"@@local."))
        .or_else(|| lower.strip_prefix(b"@@"))
        .or_else(|| strip_keyword(lower, b"session").map(<[u8]>::trim_ascii))
        .or_else(|| strip_keyword(lower, b"local").map(<[u8]>::trim_ascii))
        .unwrap_or(lower);
    name == b"sql_mode"
}

fn is_copy_from_stdin(sql: &[u8]) -> bool {
    let lower = sql.to_ascii_lowercase();
    lower.starts_with(b"copy ") && lower.windows(11).any(|w| w == b" from stdin")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn begin_atomic_bodies_keep_their_semicolons() {
        let script = b"CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE sql\n\
            BEGIN ATOMIC\n SELECT CASE WHEN true THEN 1 END;\n SELECT 2;\nEND;\n\
            BEGIN;\nSELECT 'begin; end';\nCREATE PROCEDURE p() BEGIN ATOMIC INSERT INTO t VALUES (1); END;\n";
        let statements: Vec<String> = split(Dialect::Postgres, script)
            .into_iter()
            .map(|i| match i {
                Item::Statement(s) => String::from_utf8(s).unwrap(),
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(
            statements,
            [
                "CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE sql\nBEGIN ATOMIC\n SELECT CASE WHEN true THEN 1 END;\n SELECT 2;\nEND",
                "BEGIN",
                "SELECT 'begin; end'",
                "CREATE PROCEDURE p() BEGIN ATOMIC INSERT INTO t VALUES (1); END",
            ]
        );
    }

    fn split(dialect: Dialect, script: &[u8]) -> Vec<Item> {
        let mut s = Splitter::new(dialect);
        let mut out = Vec::new();
        for line in script.split_inclusive(|&b| b == b'\n') {
            out.extend(s.push(line));
        }
        out.extend(s.finish());
        out
    }

    fn statements(items: &[Item]) -> Vec<String> {
        items
            .iter()
            .filter_map(|i| match i {
                Item::Statement(s) => Some(String::from_utf8_lossy(s).into_owned()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn postgres_quotes_comments_and_dollar_quotes() {
        let items = split(
            Dialect::Postgres,
            "SELECT 'a;b', \"x;y\" -- c;\n FROM t; /* a /* nested; */ ; */ SELECT E'it\\'s;';\n\
             CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; $body$ LANGUAGE sql;\n\
             SELECT $1, a$b FROM t;\nSELECT 'ünï;cödé' AS $é$x;y$é$;\nSELECT 1"
                .as_bytes(),
        );
        assert_eq!(
            statements(&items),
            vec![
                "SELECT 'a;b', \"x;y\" -- c;\n FROM t",
                "/* a /* nested; */ ; */ SELECT E'it\\'s;'",
                "CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; $body$ LANGUAGE sql",
                "SELECT $1, a$b FROM t",
                "SELECT 'ünï;cödé' AS $é$x;y$é$",
                "SELECT 1",
            ]
        );
    }

    #[test]
    fn postgres_copy_blocks_and_meta_commands() {
        let items = split(
            Dialect::Postgres,
            b"\\connect shop\n--\n-- Data for Name: t\n--\n\nCOPY public.t (a, b) FROM stdin;\n1\tx;y\n2\t\\N\n\\.\nSELECT 1;\n",
        );
        assert_eq!(
            items,
            vec![
                Item::Meta("\\connect shop".into()),
                Item::CopyStart("COPY public.t (a, b) FROM stdin".into()),
                Item::CopyData(b"1\tx;y\n".to_vec()),
                Item::CopyData(b"2\t\\N\n".to_vec()),
                Item::CopyEnd,
                Item::Statement(b"SELECT 1".to_vec()),
            ]
        );
    }

    #[test]
    fn mysql_delimiters_and_conditional_comments() {
        let items = split(
            Dialect::Mysql,
            b"/*!40101 SET NAMES utf8mb4 */;\n-- comment;\n# another;\nINSERT INTO `a;b` VALUES ('it\\'s;', \"q;\");\n\
              DELIMITER ;;\nCREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN SET @a = 1; END ;;\nDELIMITER ;\n\
              SELECT 1--2;\n",
        );
        assert_eq!(
            statements(&items),
            vec![
                "/*!40101 SET NAMES utf8mb4 */",
                "-- comment;\n# another;\nINSERT INTO `a;b` VALUES ('it\\'s;', \"q;\")",
                "CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN SET @a = 1; END",
                "SELECT 1--2",
            ]
        );
    }

    #[test]
    fn mysql_binary_strings_pass_through() {
        let script = b"INSERT INTO t VALUES ('\x00\xff\\'\xfe;');\nSELECT 2;\n";
        let items = split(Dialect::Mysql, script);
        assert_eq!(
            items,
            vec![
                Item::Statement(b"INSERT INTO t VALUES ('\x00\xff\\'\xfe;')".to_vec()),
                Item::Statement(b"SELECT 2".to_vec()),
            ]
        );
    }

    #[test]
    fn postgres_semicolons_in_parentheses_dont_end_statements() {
        let items = split(
            Dialect::Postgres,
            b"CREATE RULE r AS\n    ON INSERT TO public.t DO ( INSERT INTO public.a VALUES (1);\n INSERT INTO public.b VALUES (2);\n);\n\
              SELECT '(', \"a(\", $$ ( $$ -- (\n;\nSELECT 1 /* ( */;\nSELECT 2);\nSELECT 3;\n",
        );
        assert_eq!(
            statements(&items),
            vec![
                "CREATE RULE r AS\n    ON INSERT TO public.t DO ( INSERT INTO public.a VALUES (1);\n INSERT INTO public.b VALUES (2);\n)",
                "SELECT '(', \"a(\", $$ ( $$ -- (",
                "SELECT 1 /* ( */",
                "SELECT 2)",
                "SELECT 3",
            ]
        );
    }

    #[test]
    fn mysql_parentheses_dont_hold_statements_open() {
        let items = split(
            Dialect::Mysql,
            b"SELECT (1;\nDELIMITER ;;\nCREATE PROCEDURE p() BEGIN SELECT (1); END ;;\nDELIMITER ;\nSELECT 2;\n",
        );
        assert_eq!(
            statements(&items),
            vec![
                "SELECT (1",
                "CREATE PROCEDURE p() BEGIN SELECT (1); END",
                "SELECT 2"
            ]
        );
    }

    #[test]
    fn mysql_no_backslash_escapes_follows_sql_mode() {
        let items = split(
            Dialect::Mysql,
            b"/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;\n\
              SELECT 'a\\';b';\n\
              /*!50003 SET @saved_sql_mode       = @@sql_mode */ ;\n\
              /*!50003 SET sql_mode              = 'STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES' */ ;\n\
              DELIMITER ;;\nCREATE PROCEDURE p() BEGIN SELECT 'c:\\'; SELECT \"d\\\"; END ;;\nDELIMITER ;\n\
              SELECT 'e\\';\n\
              /*!50003 SET sql_mode              = @saved_sql_mode */ ;\n\
              SELECT 'f\\';g';\n\
              SET SESSION sql_mode = CONCAT(@@sql_mode, ',NO_BACKSLASH_ESCAPES');\n\
              SELECT 'h\\';\n\
              /*!40101 SET SQL_MODE=@OLD_SQL_MODE */;\n\
              SELECT 'i\\';j';\n",
        );
        assert_eq!(
            statements(&items),
            vec![
                "/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */",
                "SELECT 'a\\';b'",
                "/*!50003 SET @saved_sql_mode       = @@sql_mode */",
                "/*!50003 SET sql_mode              = 'STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES' */",
                "CREATE PROCEDURE p() BEGIN SELECT 'c:\\'; SELECT \"d\\\"; END",
                "SELECT 'e\\'",
                "/*!50003 SET sql_mode              = @saved_sql_mode */",
                "SELECT 'f\\';g'",
                "SET SESSION sql_mode = CONCAT(@@sql_mode, ',NO_BACKSLASH_ESCAPES')",
                "SELECT 'h\\'",
                "/*!40101 SET SQL_MODE=@OLD_SQL_MODE */",
                "SELECT 'i\\';j'",
            ]
        );
    }

    #[test]
    fn comment_only_text_is_not_a_statement() {
        assert!(split(Dialect::Postgres, b"-- just a comment\n/* and this */\n;\n").is_empty());
        assert!(split(Dialect::Mysql, b"/* plain */;\n").is_empty());
    }
}
