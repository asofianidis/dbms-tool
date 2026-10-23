//! Client-side check for read-only connections. PostgreSQL and MySQL sessions
//! are also put in read-only mode server-side; SQL Server has no equivalent, so
//! this scan is the safety net there.

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

/// Returns the first keyword that could modify data, ignoring strings,
/// quoted identifiers and comments.
pub fn first_write_keyword(sql: &str) -> Option<String> {
    let chars: Vec<char> = sql.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        match c {
            '-' if next == Some('-') => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            '#' => {
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
                    continue;
                }
            }
            c if c.is_alphabetic() || c == '_' => {
                let start = i;
                while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
                    i += 1;
                }
                let word: String = chars[start..i].iter().collect::<String>().to_lowercase();
                // `a.update` is a column and `REPLACE(…)` a function, not statements
                let after_dot = start > 0 && chars[start - 1] == '.';
                let mut k = i;
                while k < chars.len() && chars[k].is_whitespace() {
                    k += 1;
                }
                let is_call = chars.get(k) == Some(&'(');
                if !after_dot && !is_call && WRITE_KEYWORDS.contains(&word.as_str()) {
                    return Some(word.to_uppercase());
                }
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::first_write_keyword;

    #[test]
    fn allows_reads() {
        assert_eq!(
            first_write_keyword("SELECT * FROM t WHERE name = 'drop table'"),
            None
        );
        assert_eq!(
            first_write_keyword("select \"update\" from t -- delete"),
            None
        );
        assert_eq!(
            first_write_keyword("SELECT [delete] FROM t /* insert */"),
            None
        );
        assert_eq!(
            first_write_keyword("SELECT $$ drop $$, t.update FROM t"),
            None
        );
        assert_eq!(
            first_write_keyword("SELECT REPLACE(name, 'a', 'b') FROM t"),
            None
        );
    }

    #[test]
    fn blocks_writes() {
        assert_eq!(
            first_write_keyword("delete from t").as_deref(),
            Some("DELETE")
        );
        assert_eq!(
            first_write_keyword("WITH x AS (SELECT 1) UPDATE t SET a = 1").as_deref(),
            Some("UPDATE")
        );
        assert_eq!(
            first_write_keyword("SELECT * INTO t2 FROM t").as_deref(),
            Some("INTO")
        );
    }
}
