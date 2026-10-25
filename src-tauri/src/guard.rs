//! Client-side check for read-only connections, dashboards and export re-runs.
//! PostgreSQL and MySQL sessions on read-only connections are also put in
//! read-only mode server-side; SQL Server has no equivalent, so this scan is
//! the safety net there.

use crate::config::Engine;

const WRITE_KEYWORDS: &[&str] = &[
    "insert",
    "update",
    "delete",
    "merge",
    "upsert",
    "replace",
    "truncate",
    "drop",
    "alter",
    "create",
    "rename",
    "grant",
    "revoke",
    "deny",
    "exec",
    "execute",
    "call",
    "do",
    "copy",
    "load",
    "import",
    "vacuum",
    "reindex",
    "cluster",
    "refresh",
    "lock",
    "into",
    "backup",
    "restore",
    "dbcc",
    "kill",
    "shutdown",
    "bulk",
    "writetext",
    "updatetext",
    "reassign",
    "discard",
    "optimize",
    "repair",
    "flush",
    "purge",
    "install",
    "uninstall",
];

/// Words after which a write keyword can only be a column or alias name:
/// `SELECT refresh`, `a, update`, `AS delete`, `ORDER BY lock`, `x = replace`.
const VALUE_POSITION: &[&str] = &[
    "select", "distinct", "as", "by", "where", "and", "or", "on", "having", "between", "like",
    "in", "is",
];

/// Write keywords that are also functions: `REPLACE(s, …)`, MySQL's `INSERT(s, …)`.
/// `EXEC('…')` runs dynamic SQL, so it isn't one of them.
const FUNCTIONS: &[&str] = &["replace", "insert", "update"];

/// T-SQL statements a batch may start with. Anything else at the start of a
/// batch is a stored procedure call, since `EXEC` is optional there
/// (`sp_rename 'a', 'b'`, `master..xp_cmdshell 'dir'`).
const TSQL_STATEMENTS: &[&str] = &[
    "select",
    "with",
    "set",
    "declare",
    "print",
    "if",
    "else",
    "begin",
    "end",
    "while",
    "break",
    "continue",
    "return",
    "goto",
    "use",
    "waitfor",
    "raiserror",
    "throw",
    "open",
    "fetch",
    "close",
    "deallocate",
    "commit",
    "rollback",
    "save",
    "revert",
    "readtext",
    "values",
];

#[derive(Debug, PartialEq)]
enum Token {
    /// Unquoted word, lowercased
    Word(String),
    /// `"x"`, `` `x` `` or `[x]`
    QuotedIdent,
    /// String, number or dollar-quoted body
    Literal,
    Punct(char),
}

#[derive(Clone, Copy)]
struct Lexing {
    /// MySQL `#` comments; elsewhere `#` starts a name like `#temp`
    hash_comments: bool,
    /// `\'` inside a string escapes the quote (MySQL, PostgreSQL `E'…'`)
    backslash_escapes: bool,
}

/// Splits SQL into tokens, dropping comments and whitespace.
fn tokenize(sql: &str, lexing: Lexing) -> Vec<Token> {
    let chars: Vec<char> = sql.chars().collect();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        match c {
            c if c.is_whitespace() => {}
            '-' if next == Some('-') => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            '#' if lexing.hash_comments => {
                // MySQL line comment
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            '/' if next == Some('*') => {
                i += 2;
                while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                    i += 1;
                }
                i += 2;
                continue;
            }
            '\'' | '"' | '`' | '[' => {
                let close = if c == '[' { ']' } else { c };
                i += 1;
                while i < chars.len() {
                    if lexing.backslash_escapes && chars[i] == '\\' && matches!(c, '\'' | '"') {
                        i += 2;
                        continue;
                    }
                    if chars[i] == close {
                        // Doubled quote is an escaped quote
                        if chars.get(i + 1) == Some(&close) && close != ']' {
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    i += 1;
                }
                tokens.push(if c == '\'' {
                    Token::Literal
                } else {
                    Token::QuotedIdent
                });
            }
            '$' if next.is_some_and(|n| n == '$' || n.is_alphabetic() || n == '_') => {
                // PostgreSQL dollar quoting: $tag$ … $tag$
                let start = i;
                let mut j = i + 1;
                while j < chars.len() && (chars[j].is_alphanumeric() || chars[j] == '_') {
                    j += 1;
                }
                if chars.get(j) == Some(&'$') {
                    let tag: String = chars[start..=j].iter().collect();
                    let rest: String = chars[j + 1..].iter().collect();
                    match rest.find(&tag) {
                        Some(p) => i = j + 1 + rest[..p].chars().count() + tag.chars().count(),
                        None => i = chars.len(),
                    }
                    tokens.push(Token::Literal);
                    continue;
                }
                tokens.push(Token::Punct(c));
            }
            c if c.is_ascii_digit() => {
                while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '.') {
                    i += 1;
                }
                tokens.push(Token::Literal);
                continue;
            }
            c if c.is_alphabetic() || matches!(c, '_' | '@' | '#') => {
                let start = i;
                while i < chars.len()
                    && (chars[i].is_alphanumeric() || matches!(chars[i], '_' | '@' | '$' | '#'))
                {
                    i += 1;
                }
                let word: String = chars[start..i].iter().collect::<String>().to_lowercase();
                tokens.push(Token::Word(word));
                continue;
            }
            c => tokens.push(Token::Punct(c)),
        }
        i += 1;
    }
    tokens
}

/// Whether the write keyword at `i` is really a name: `t.update`, `REPLACE(…)`,
/// or a column in a select list or condition.
fn used_as_name(tokens: &[Token], i: usize) -> bool {
    let prev = i.checked_sub(1).map(|p| &tokens[p]);
    let next = tokens.get(i + 1);
    match prev {
        Some(Token::Punct('.')) => return true,
        Some(Token::Punct(',' | '=' | '<' | '>' | '+' | '-' | '*' | '/' | '%')) => return true,
        Some(Token::Word(w)) if VALUE_POSITION.contains(&w.as_str()) => return true,
        _ => {}
    }
    match next {
        Some(Token::Punct('(')) => {
            matches!(&tokens[i], Token::Word(w) if FUNCTIONS.contains(&w.as_str()))
        }
        Some(Token::Punct('.' | ',' | ')' | '=' | '<' | '>')) => true,
        _ => false,
    }
}

/// Returns the first keyword that could modify data, ignoring strings,
/// quoted identifiers, comments and keywords used as column names.
pub fn first_write_keyword(sql: &str, engine: Engine) -> Option<String> {
    let hash_comments = engine == Engine::Mysql;
    // Whether `'` escapes depends on server settings (NO_BACKSLASH_ESCAPES,
    // E'' strings), so read the script both ways and block if either finds a write
    let escapes: &[bool] = match engine {
        Engine::Mysql | Engine::Postgres => &[false, true],
        _ => &[false],
    };
    for &backslash_escapes in escapes {
        let tokens = tokenize(
            sql,
            Lexing {
                hash_comments,
                backslash_escapes,
            },
        );
        if let Some(word) = write_keyword(&tokens) {
            return Some(word);
        }
    }
    if matches!(engine, Engine::Mssql | Engine::Babelfish) {
        return tsql_batches(sql).find_map(batch_procedure_call);
    }
    None
}

fn write_keyword(tokens: &[Token]) -> Option<String> {
    tokens
        .iter()
        .enumerate()
        .find_map(|(i, token)| match token {
            Token::Word(word)
                if WRITE_KEYWORDS.contains(&word.as_str())
                // INTO is never a name, and `SELECT … INTO t` creates a table
                && (word == "into" || !used_as_name(tokens, i)) =>
            {
                Some(word.to_uppercase())
            }
            _ => None,
        })
}

/// Splits a T-SQL script on `GO` lines, as the client tools do.
fn tsql_batches(sql: &str) -> impl Iterator<Item = String> + '_ {
    let mut batches = vec![String::new()];
    for line in sql.lines() {
        let mut words = line.split_whitespace();
        let is_go = words.next().is_some_and(|w| w.eq_ignore_ascii_case("go"))
            && words.all(|w| w.chars().all(|c| c.is_ascii_digit()));
        if is_go {
            batches.push(String::new());
        } else {
            let batch = batches.last_mut().expect("never empty");
            batch.push_str(line);
            batch.push('\n');
        }
    }
    batches.into_iter()
}

/// The procedure a batch calls without `EXEC`, if its first statement is one.
fn batch_procedure_call(batch: String) -> Option<String> {
    let tokens = tokenize(
        &batch,
        Lexing {
            hash_comments: false,
            backslash_escapes: false,
        },
    );
    let first = tokens.iter().find(|t| **t != Token::Punct(';'))?;
    let name = match first {
        Token::Word(w) if TSQL_STATEMENTS.contains(&w.as_str()) => return None,
        // `label:` before a statement
        Token::Word(_) if tokens.get(1) == Some(&Token::Punct(':')) => return None,
        Token::Word(w) => w.clone(),
        Token::QuotedIdent => "procedure".to_string(),
        _ => return None,
    };
    Some(format!("EXEC (calling {name} without EXEC)"))
}

#[cfg(test)]
mod tests {
    use super::first_write_keyword;
    use crate::config::Engine;

    fn pg(sql: &str) -> Option<String> {
        first_write_keyword(sql, Engine::Postgres)
    }

    fn ms(sql: &str) -> Option<String> {
        first_write_keyword(sql, Engine::Mssql)
    }

    #[test]
    fn allows_reads() {
        assert_eq!(pg("SELECT * FROM t WHERE name = 'drop table'"), None);
        assert_eq!(pg("select \"update\" from t -- delete"), None);
        assert_eq!(pg("SELECT [delete] FROM t /* insert */"), None);
        assert_eq!(pg("SELECT $$ drop $$, t.update FROM t"), None);
        assert_eq!(pg("SELECT REPLACE(name, 'a', 'b') FROM t"), None);
        assert_eq!(pg("SHOW TABLES"), None);
        assert_eq!(pg("WITH t AS (SELECT 1) SELECT * FROM t"), None);
    }

    #[test]
    fn allows_keyword_named_columns() {
        assert_eq!(pg("SELECT refresh FROM t"), None);
        assert_eq!(pg("SELECT id, lock, merge FROM t ORDER BY copy"), None);
        assert_eq!(pg("SELECT x AS delete FROM t WHERE refresh = 1"), None);
        assert_eq!(pg("SELECT * FROM t WHERE a = 1 AND load > 2"), None);
        assert_eq!(pg("SELECT count(refresh) FROM t GROUP BY refresh"), None);
    }

    #[test]
    fn blocks_writes() {
        assert_eq!(pg("delete from t").as_deref(), Some("DELETE"));
        assert_eq!(
            pg("WITH x AS (SELECT 1) UPDATE t SET a = 1").as_deref(),
            Some("UPDATE")
        );
        assert_eq!(pg("SELECT * INTO t2 FROM t").as_deref(), Some("INTO"));
        assert_eq!(pg("select 1; delete from users").as_deref(), Some("DELETE"));
        assert_eq!(pg("/* hi */ DROP TABLE x").as_deref(), Some("DROP"));
        assert_eq!(
            pg("WITH gone AS (DELETE FROM t RETURNING *) SELECT count(*) FROM gone").as_deref(),
            Some("DELETE")
        );
        assert_eq!(
            pg("EXPLAIN ANALYZE DELETE FROM t").as_deref(),
            Some("DELETE")
        );
        assert_eq!(pg("SELECT * FROM t FOR UPDATE").as_deref(), Some("UPDATE"));
        assert_eq!(ms("IF 1 = 1 DELETE FROM t").as_deref(), Some("DELETE"));
        assert_eq!(
            ms("BEGIN TRY DROP TABLE t END TRY").as_deref(),
            Some("DROP")
        );
        assert_eq!(ms("EXEC sp_cleanup").as_deref(), Some("EXEC"));
        assert_eq!(ms("EXEC('DROP TABLE t')").as_deref(), Some("EXEC"));
        assert_eq!(
            ms("IF @a = 1 SELECT 1 ELSE DELETE FROM t").as_deref(),
            Some("DELETE")
        );
        assert_eq!(
            ms("SELECT * FROM #tmp; DELETE FROM t").as_deref(),
            Some("DELETE")
        );
        let my = |sql| first_write_keyword(sql, Engine::Mysql);
        assert_eq!(my("SELECT 1 # delete"), None);
        // MariaDB's ANALYZE runs the statement it explains
        assert_eq!(
            my("ANALYZE FORMAT=JSON\nDELETE FROM t WHERE a = 1").as_deref(),
            Some("DELETE")
        );
        assert_eq!(my("EXPLAIN FORMAT=JSON\nSELECT * FROM t"), None);
        // `\'` keeps the string open in MySQL, so the DELETE is real
        assert_eq!(
            my(r"SELECT 'a\'' ; DELETE FROM t; -- '").as_deref(),
            Some("DELETE")
        );
    }

    #[test]
    fn blocks_tsql_procedure_calls_without_exec() {
        assert!(ms("sp_rename 'a', 'b'").is_some_and(|k| k.contains("sp_rename")));
        assert!(ms("xp_cmdshell 'dir'").is_some());
        assert!(ms("  -- note\n  master..xp_cmdshell 'dir'").is_some());
        assert!(ms("[dbo].[purge_all]").is_some());
        assert!(ms("SELECT 1\nGO\nsp_configure 'x', 1").is_some());
        assert!(ms(";sp_who").is_some());
        // Only the first statement of a batch can omit EXEC
        assert_eq!(ms("SELECT 1\nGO 2\nSELECT name FROM sys.tables"), None);
        assert_eq!(ms("DECLARE @x int = 1; SELECT @x"), None);
        // Other engines treat a bare name as a syntax error, not a call
        assert_eq!(pg("sp_rename 'a', 'b'"), None);
    }
}
