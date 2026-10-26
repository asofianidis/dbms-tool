//! Client-side check for read-only connections, dashboards and export re-runs.
//! PostgreSQL and MySQL sessions on read-only connections are also put in
//! read-only mode server-side; SQL Server has no equivalent, so this scan is
//! the safety net there.

use crate::config::Engine;
use crate::drivers::mssql::split_batches;

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

/// T-SQL-only statements that change data or server state: Service Broker's
/// `RECEIVE` (which dequeues, also inside `WAITFOR (…)`) and `SEND`, and
/// `ENABLE` / `DISABLE TRIGGER`
const TSQL_WRITE_KEYWORDS: &[&str] = &["receive", "send", "enable", "disable"];

/// Service Broker statements that start with an allowed word (`END`, `BEGIN`),
/// or lock a conversation group (`GET`, also inside `WAITFOR (…)`)
const TSQL_WRITE_PAIRS: &[[&str; 2]] = &[
    ["end", "conversation"],
    ["begin", "conversation"],
    ["begin", "dialog"],
    ["move", "conversation"],
    ["get", "conversation"],
];

/// Words after which a write keyword can only be a column or alias name:
/// `SELECT refresh`, `a, update`, `AS delete`, `ORDER BY lock`, `x = replace`.
/// Not `on`: T-SQL's `SET NOCOUNT ON` can run straight into the next statement,
/// and a column after a join's `ON` is followed by a comparison anyway.
const VALUE_POSITION: &[&str] = &[
    "select", "distinct", "as", "by", "where", "and", "or", "having", "between", "like", "in", "is",
];

/// Settings that hold PostgreSQL's and MySQL's read-only mode
const READ_ONLY_SETTINGS: &[&str] = &[
    "default_transaction_read_only",
    "transaction_read_only",
    "tx_read_only",
];

/// MySQL `SET` targets that change the server or an account rather than the session
const MYSQL_SERVER_SETTINGS: &[&str] = &["global", "persist", "persist_only", "password"];

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
    /// MySQL comments: `#` starts one (elsewhere it starts a name like `#temp`),
    /// `--` needs a space after it, and the body of `/*! … */` runs as code
    mysql_comments: bool,
    /// `[x]` is a name (T-SQL, SQLite); elsewhere `[` is a subscript
    bracket_idents: bool,
    /// `\'` inside a string escapes the quote (MySQL, PostgreSQL `E'…'`)
    backslash_escapes: bool,
}

/// Splits SQL into tokens, dropping comments and whitespace.
fn tokenize(sql: &str, lexing: Lexing) -> Vec<Token> {
    let chars: Vec<char> = sql.chars().collect();
    let mut tokens = Vec::new();
    // Inside MySQL's `/*! … */`, whose body runs
    let mut in_executable_comment = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        match c {
            c if c.is_whitespace() => {}
            // MySQL reads `5--1` as `5 - -1`
            '-' if next == Some('-')
                && (!lexing.mysql_comments
                    || chars
                        .get(i + 2)
                        .is_none_or(|c| c.is_whitespace() || c.is_control())) =>
            {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            '#' if lexing.mysql_comments => {
                // MySQL line comment
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            '/' if next == Some('*') => {
                // `/*! … */`, `/*!50000 … */` and MariaDB's `/*M! … */` run on the server
                let bang = if chars.get(i + 2) == Some(&'M') {
                    i + 3
                } else {
                    i + 2
                };
                if lexing.mysql_comments && chars.get(bang) == Some(&'!') {
                    i = bang + 1;
                    while i < chars.len() && chars[i].is_ascii_digit() {
                        i += 1;
                    }
                    in_executable_comment = true;
                    continue;
                }
                i += 2;
                while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                    i += 1;
                }
                i += 2;
                continue;
            }
            '*' if in_executable_comment && next == Some('/') => {
                in_executable_comment = false;
                i += 2;
                continue;
            }
            '\'' | '"' | '`' | '[' if c != '[' || lexing.bracket_idents => {
                let close = if c == '[' { ']' } else { c };
                i += 1;
                while i < chars.len() {
                    if lexing.backslash_escapes && chars[i] == '\\' && matches!(c, '\'' | '"') {
                        i += 2;
                        continue;
                    }
                    if chars[i] == close {
                        // Doubled quote is an escaped quote, `]]` included
                        if chars.get(i + 1) == Some(&close) {
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
    let mysql_comments = engine == Engine::Mysql;
    let bracket_idents = matches!(engine, Engine::Mssql | Engine::Babelfish | Engine::Sqlite);
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
                mysql_comments,
                bracket_idents,
                backslash_escapes,
            },
        );
        if let Some(word) =
            write_keyword(&tokens, engine).or_else(|| session_write(&tokens, engine))
        {
            return Some(word);
        }
    }
    if matches!(engine, Engine::Mssql | Engine::Babelfish) {
        // Split exactly as the driver does, so each batch it sends is checked
        return split_batches(sql)
            .into_iter()
            .find_map(|(_, batch, _)| batch_procedure_call(batch));
    }
    None
}

fn write_keyword(tokens: &[Token], engine: Engine) -> Option<String> {
    let tsql = matches!(engine, Engine::Mssql | Engine::Babelfish);
    tokens
        .iter()
        .enumerate()
        .find_map(|(i, token)| match token {
            Token::Word(word)
                if (WRITE_KEYWORDS.contains(&word.as_str())
                    || (tsql && TSQL_WRITE_KEYWORDS.contains(&word.as_str())))
                // INTO is never a name, and `SELECT … INTO t` creates a table
                && (word == "into" || !used_as_name(tokens, i)) =>
            {
                Some(word.to_uppercase())
            }
            Token::Word(word) if tsql => tsql_write_pair(tokens, i, word),
            _ => None,
        })
}

/// `END CONVERSATION @h` and the like at `i`. `END conversation` can also close
/// a `CASE` before an alias, but then no handle follows.
fn tsql_write_pair(tokens: &[Token], i: usize, word: &str) -> Option<String> {
    let Some(Token::Word(next)) = tokens.get(i + 1) else {
        return None;
    };
    if !TSQL_WRITE_PAIRS.contains(&[word, next.as_str()]) {
        return None;
    }
    let handle = match tokens.get(i + 2) {
        Some(Token::Word(w)) => w.starts_with('@'),
        Some(Token::Literal) => true,
        _ => false,
    };
    if word == "end" && !handle {
        return None;
    }
    Some(format!("{word} {next}").to_uppercase())
}

/// Statements that switch off the server-side read-only mode of read-only
/// connections (`BEGIN READ WRITE`, `RESET ALL`), or change more than the
/// session (MySQL's `SET GLOBAL`, SQLite's `PRAGMA writable_schema`).
fn session_write(tokens: &[Token], engine: Engine) -> Option<String> {
    for statement in tokens.split(|t| *t == Token::Punct(';')) {
        let words: Vec<&str> = statement
            .iter()
            .map(|t| match t {
                // `@@session.x` and `@@x` name the same setting as `x`
                Token::Word(w) => w.trim_start_matches("@@"),
                _ => "",
            })
            .collect();
        // BEGIN / START TRANSACTION / SET [SESSION CHARACTERISTICS AS] TRANSACTION … READ WRITE
        if words.windows(2).any(|w| w == ["read", "write"]) {
            return Some("READ WRITE".into());
        }
        // `SELECT set_config('default_transaction_read_only', 'off', false)`
        if engine == Engine::Postgres
            && statement
                .windows(2)
                .any(|w| w[0] == Token::Word("set_config".into()) && w[1] == Token::Punct('('))
        {
            return Some("SET_CONFIG".into());
        }
        let first = words.first().copied().unwrap_or_default();
        let found = match (first, engine) {
            ("reset", Engine::Postgres) if words.get(1) == Some(&"all") => Some("all"),
            ("set" | "reset", Engine::Postgres | Engine::Mysql) => {
                words.iter().copied().find(|w| {
                    READ_ONLY_SETTINGS.contains(w)
                        || (engine == Engine::Mysql && MYSQL_SERVER_SETTINGS.contains(w))
                })
            }
            ("pragma", Engine::Sqlite) => words.iter().copied().find(|w| *w == "writable_schema"),
            _ => None,
        };
        if let Some(found) = found {
            return Some(format!("{first} {found}").to_uppercase());
        }
    }
    None
}

/// The procedure a batch calls without `EXEC`, if its first statement is one.
fn batch_procedure_call(batch: String) -> Option<String> {
    let tokens = tokenize(
        &batch,
        Lexing {
            mysql_comments: false,
            bracket_idents: true,
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
        assert_eq!(ms("SELECT [delete] FROM t /* insert */"), None);
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

    #[test]
    fn blocks_service_broker_and_trigger_switches() {
        for sql in [
            "WAITFOR (RECEIVE TOP(100) * FROM q), TIMEOUT 1000",
            "WAITFOR (GET CONVERSATION GROUP @g FROM q), TIMEOUT 1000",
            "SELECT 1; RECEIVE * FROM q",
            "SELECT 1; GET CONVERSATION GROUP @g FROM q",
            "SELECT 1; DISABLE TRIGGER ALL ON DATABASE",
            "ENABLE TRIGGER t ON x",
            "SEND ON CONVERSATION @h MESSAGE TYPE m (@body)",
            "END CONVERSATION @h WITH CLEANUP",
            "IF 1 = 1 BEGIN END CONVERSATION @h END",
            "BEGIN DIALOG CONVERSATION @h FROM SERVICE a TO SERVICE 'b'",
            "BEGIN CONVERSATION TIMER (@h) TIMEOUT = 60",
            "MOVE CONVERSATION @h TO @g",
        ] {
            assert!(ms(sql).is_some(), "{sql}");
        }
        assert_eq!(ms("WAITFOR DELAY '00:00:01'"), None);
        assert_eq!(ms("WAITFOR DELAY '00:00:01'; SELECT 1"), None);
        assert_eq!(ms("BEGIN TRAN; SELECT 1; COMMIT"), None);
        assert_eq!(
            ms("IF 1 = 1 BEGIN SELECT 1 END ELSE BEGIN SELECT 2 END"),
            None
        );
        assert_eq!(
            ms("SELECT CASE WHEN a = 1 THEN 1 END conversation FROM t"),
            None
        );
        assert_eq!(ms("SELECT send, receive FROM t WHERE enable = 1"), None);
        // Only T-SQL has these statements
        assert_eq!(pg("SELECT 1; RECEIVE * FROM q"), None);
    }

    #[test]
    fn splits_tsql_batches_like_the_driver() {
        assert!(ms("SELECT 1\nGO -- next\nxp_cmdshell 'dir'").is_some());
        assert!(ms("SELECT 1\ngo 5 -- twice\nxp_cmdshell 'dir'").is_some());
        assert_eq!(ms("SELECT 1\nGO -- next\nSELECT 2"), None);
    }

    #[test]
    fn reads_escaped_brackets_in_tsql_names() {
        assert_eq!(
            ms("SELECT 1 AS [x]]'];DELETE FROM t;--']").as_deref(),
            Some("DELETE")
        );
        assert_eq!(ms("SELECT [a]]delete] FROM t"), None);
        let lite = |sql| first_write_keyword(sql, Engine::Sqlite);
        assert_eq!(
            lite("SELECT [x]]'];DELETE FROM t;--']").as_deref(),
            Some("DELETE")
        );
        assert_eq!(lite("SELECT [delete] FROM t"), None);
    }

    #[test]
    fn brackets_are_subscripts_on_postgres() {
        assert_eq!(
            pg("SELECT arr[length(']')] FROM t; DELETE FROM t; -- '").as_deref(),
            Some("DELETE")
        );
        assert_eq!(pg("SELECT arr[1] FROM t"), None);
    }

    #[test]
    fn blocks_writes_after_set_options() {
        assert_eq!(
            ms("SET NOCOUNT ON\nDELETE FROM t").as_deref(),
            Some("DELETE")
        );
        assert_eq!(
            ms("SET XACT_ABORT ON UPDATE t SET a=1").as_deref(),
            Some("UPDATE")
        );
        assert_eq!(ms("SET NOCOUNT ON\nSELECT 1"), None);
        assert_eq!(pg("SELECT * FROM a JOIN b ON update = b.id"), None);
        assert_eq!(
            pg("SELECT * FROM a JOIN b ON a.id = b.id AND lock > 1"),
            None
        );
    }

    #[test]
    fn follows_mysql_comment_rules() {
        let my = |sql| first_write_keyword(sql, Engine::Mysql);
        assert_eq!(my("SELECT 5--1; DELETE FROM t").as_deref(), Some("DELETE"));
        assert_eq!(my("SELECT 1 -- delete"), None);
        assert_eq!(my("SELECT 1 --\tdelete"), None);
        assert_eq!(
            my("SELECT 1 /*! ; DELETE FROM t */").as_deref(),
            Some("DELETE")
        );
        assert_eq!(
            my("SELECT 1 /*!50000 ; DELETE FROM t */").as_deref(),
            Some("DELETE")
        );
        assert_eq!(
            my("SELECT 1 /*M!100100 ; DELETE FROM t */").as_deref(),
            Some("DELETE")
        );
        assert_eq!(my("SELECT /*!40001 SQL_NO_CACHE */ * FROM t"), None);
        assert_eq!(my("SELECT 1 /* delete */"), None);
        // Other engines end the line at any `--`
        assert_eq!(pg("SELECT 5--1; DELETE FROM t"), None);
    }

    #[test]
    fn blocks_leaving_read_only_mode() {
        for sql in [
            "BEGIN READ WRITE",
            "START TRANSACTION READ WRITE",
            "BEGIN ISOLATION LEVEL SERIALIZABLE, READ WRITE",
            "SET default_transaction_read_only = off",
            "SET SESSION default_transaction_read_only TO off",
            "SET LOCAL transaction_read_only = off",
            "RESET default_transaction_read_only",
            "RESET ALL",
            "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE",
            "SET TRANSACTION READ WRITE",
            "SELECT 1; SET default_transaction_read_only = off",
            "SELECT set_config('default_transaction_read_only', 'off', false)",
        ] {
            assert!(pg(sql).is_some(), "{sql}");
        }
        let my = |sql| first_write_keyword(sql, Engine::Mysql);
        for sql in [
            "SET SESSION TRANSACTION READ WRITE",
            "SET TRANSACTION READ WRITE",
            "START TRANSACTION READ WRITE",
            "SET GLOBAL max_connections = 1",
            "SET @@global.read_only = 0",
            "SET PERSIST max_connections = 1",
            "SET PERSIST_ONLY max_connections = 1",
            "SET PASSWORD = 'x'",
            "SET SESSION transaction_read_only = 0",
            "SET @@session.transaction_read_only = 0",
            "SET tx_read_only = 0",
            "SET @@tx_read_only = 0",
            "SET NAMES utf8mb4, GLOBAL max_connections = 1",
            "/*!80000 SET GLOBAL max_connections = 1 */",
        ] {
            assert!(my(sql).is_some(), "{sql}");
        }
        let lite = |sql| first_write_keyword(sql, Engine::Sqlite);
        assert!(lite("PRAGMA writable_schema = ON").is_some());
        assert!(lite("PRAGMA main.writable_schema = 1").is_some());

        // Ordinary session settings stay allowed
        assert_eq!(pg("SET search_path TO app, public"), None);
        assert_eq!(pg("BEGIN"), None);
        assert_eq!(pg("BEGIN READ ONLY"), None);
        assert_eq!(pg("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE"), None);
        assert_eq!(pg("SHOW default_transaction_read_only"), None);
        assert_eq!(my("SET NAMES utf8mb4"), None);
        assert_eq!(my("SET @password = 'x'"), None);
        assert_eq!(
            my("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED"),
            None
        );
        assert_eq!(my("SELECT @@global.read_only"), None);
        assert_eq!(ms("SET NOCOUNT ON"), None);
        assert_eq!(
            ms("SET TRANSACTION ISOLATION LEVEL READ COMMITTED\nSELECT 1"),
            None
        );
        assert_eq!(lite("PRAGMA table_info(t)"), None);
    }
}
