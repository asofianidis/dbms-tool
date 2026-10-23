//! Splits a SQL script into statements as it streams in, the way psql and the
//! mysql client do: quotes, comments and dollar quotes hide semicolons, COPY …
//! FROM stdin is followed by its data, backslash commands stand alone, and
//! MySQL's DELIMITER changes what ends a statement.
//!
//! It works on bytes: everything it looks for is ASCII, and mysqldump writes
//! binary values as raw bytes inside string literals, which must pass through
//! untouched.

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
                    if line[i..].starts_with(&self.delimiter) {
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
                            let backslash = self.dialect == Dialect::Mysql
                                || (i > 0
                                    && matches!(line[i - 1], b'E' | b'e')
                                    && (i < 2 || !is_ident(line[i - 2])));
                            self.state = State::Single { backslash };
                            self.content = true;
                        }
                        b'"' => {
                            self.state = State::Double {
                                backslash: self.dialect == Dialect::Mysql,
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

    fn finish_statement(&mut self) -> Item {
        let sql = std::mem::take(&mut self.buf).trim_ascii().to_vec();
        self.content = false;
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

fn is_copy_from_stdin(sql: &[u8]) -> bool {
    let lower = sql.to_ascii_lowercase();
    lower.starts_with(b"copy ") && lower.windows(11).any(|w| w == b" from stdin")
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn comment_only_text_is_not_a_statement() {
        assert!(split(Dialect::Postgres, b"-- just a comment\n/* and this */\n;\n").is_empty());
        assert!(split(Dialect::Mysql, b"/* plain */;\n").is_empty());
    }
}
