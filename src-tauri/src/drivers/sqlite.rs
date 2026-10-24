//! SQLite: local database files (rusqlite) and Cloudflare D1, which speaks
//! SQLite over its REST API. Both run SQL through `Backend::run`; everything
//! else (catalog, structure, completion) is shared and uses only the PRAGMAs
//! D1 documents as supported.

use std::sync::Arc;
use std::time::Duration;

use rusqlite::fallible_iterator::FallibleIterator as _;
use rusqlite::types::ValueRef;
use serde::Deserialize;
use serde_json::Value;

use crate::cloud::{self, Provider};
use crate::config::ConnectionConfig;
use crate::error::{AppError, AppResult};
use crate::model::*;

/// SQLite has one database per connection; attached ones aren't browsed.
const MAIN: &str = "main";

/// One statement's outcome.
#[derive(Debug, Default)]
struct StatementResult {
    columns: Vec<ColumnMeta>,
    rows: Vec<Vec<Value>>,
    /// Rows the statement produced, including any beyond the row limit
    total: u64,
    /// Rows changed, for INSERT / UPDATE / DELETE
    changes: Option<u64>,
}

struct D1 {
    account: String,
    database: String,
    token: String,
}

enum Backend {
    File {
        conn: Arc<std::sync::Mutex<rusqlite::Connection>>,
        interrupt: Arc<rusqlite::InterruptHandle>,
    },
    D1(D1),
}

pub struct SqSession {
    backend: Backend,
    pub database: String,
}

#[derive(Deserialize)]
struct CloudRef {
    #[serde(default)]
    provider: String,
    #[serde(default)]
    context: String,
    #[serde(default)]
    resource: String,
    #[serde(default)]
    account: String,
}

pub async fn connect(cfg: &ConnectionConfig, password: Option<&str>) -> AppResult<SqSession> {
    let d1 = cfg
        .cloud
        .clone()
        .and_then(|v| serde_json::from_value::<CloudRef>(v).ok())
        .filter(|c| c.provider == "cloudflare");
    let backend = match d1 {
        Some(cloud) => {
            if cloud.context.is_empty() || cloud.resource.is_empty() {
                return Err(AppError::msg("Enter the D1 account ID and database ID"));
            }
            let token = password
                .filter(|p| !p.is_empty())
                .map(str::to_string)
                .or_else(|| cloud::stored_token(Provider::Cloudflare, &cloud.account))
                .ok_or_else(|| {
                    AppError::msg("Add a Cloudflare API token, here or in the Cloud databases tab")
                })?;
            Backend::D1(D1 {
                account: cloud.context,
                database: cloud.resource,
                token,
            })
        }
        None => open_file(cfg).await?,
    };
    let session = SqSession {
        backend,
        database: MAIN.into(),
    };
    // Fail at connect time rather than on the first query
    session.query("SELECT 1").await?;
    Ok(session)
}

async fn open_file(cfg: &ConnectionConfig) -> AppResult<Backend> {
    let path = cfg.host.trim().to_string();
    if path.is_empty() {
        return Err(AppError::msg("Choose a database file"));
    }
    if !std::path::Path::new(&path).is_file() {
        return Err(AppError::msg(format!("No database file at {path}")));
    }
    let read_only = cfg.read_only;
    let conn = tokio::task::spawn_blocking(move || {
        use rusqlite::OpenFlags;
        // Never create files here: a mistyped path should fail, not leave an empty database
        let mut flags = OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        flags |= if read_only {
            OpenFlags::SQLITE_OPEN_READ_ONLY
        } else {
            OpenFlags::SQLITE_OPEN_READ_WRITE
        };
        let conn = rusqlite::Connection::open_with_flags(&path, flags)?;
        // Wait for other writers (another tab, another app) instead of failing at once
        conn.busy_timeout(Duration::from_secs(5))?;
        Ok::<_, rusqlite::Error>(conn)
    })
    .await
    .map_err(|e| AppError::msg(e.to_string()))?
    .map_err(sqlite_error)?;
    let interrupt = Arc::new(conn.get_interrupt_handle());
    Ok(Backend::File {
        conn: Arc::new(std::sync::Mutex::new(conn)),
        interrupt,
    })
}

fn sqlite_error(e: rusqlite::Error) -> AppError {
    AppError::msg(match &e {
        rusqlite::Error::SqliteFailure(_, Some(message)) => message.clone(),
        other => other.to_string(),
    })
}

fn cell(value: ValueRef<'_>, max_binary: usize) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::String(i.to_string()),
        ValueRef::Real(f) => Value::String(f.to_string()),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Value::String(hex_bytes_max(b, max_binary)),
    }
}

/// Whether a statement changes rows, so its change count is worth reporting.
fn is_dml(sql: &str) -> bool {
    let first = sql
        .trim_start()
        .split(|c: char| !c.is_ascii_alphabetic())
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    matches!(first.as_str(), "INSERT" | "UPDATE" | "DELETE" | "REPLACE")
}

/// Row limits for one run, and the export sink that takes a result set's rows instead.
#[derive(Clone)]
struct RunLimits {
    max_rows: usize,
    max_binary: usize,
    sink: Option<SinkHandle>,
}

impl RunLimits {
    fn all() -> Self {
        Self {
            max_rows: usize::MAX,
            max_binary: usize::MAX,
            sink: None,
        }
    }
}

/// Runs every statement in `sql` on a local file, stopping at the first error.
fn run_file(
    conn: &rusqlite::Connection,
    sql: &str,
    limits: &RunLimits,
    out: &mut Vec<StatementResult>,
) -> rusqlite::Result<()> {
    let max_rows = limits.max_rows;
    let mut sets = 0;
    let mut batch = rusqlite::Batch::new(conn, sql);
    while let Some(mut stmt) = batch.next()? {
        if stmt.column_count() == 0 {
            let changes = stmt.execute([])? as u64;
            let dml = stmt.expanded_sql().as_deref().is_some_and(is_dml);
            out.push(StatementResult {
                changes: dml.then_some(changes),
                ..Default::default()
            });
            continue;
        }
        let columns: Vec<ColumnMeta> = stmt
            .columns()
            .iter()
            .map(|c| ColumnMeta {
                name: c.name().to_string(),
                type_name: c.decl_type().unwrap_or("").to_string(),
            })
            .collect();
        let width = columns.len();
        // An export's rows go straight to the file rather than through memory
        let sink = limits.sink.as_ref().filter(|s| s.set == sets);
        sets += 1;
        if let Some(sink) = sink {
            sink.begin(&columns);
        }
        let mut result = StatementResult {
            columns,
            ..Default::default()
        };
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            result.total += 1;
            if sink.is_some() || result.rows.len() < max_rows {
                let mut values = Vec::with_capacity(width);
                for i in 0..width {
                    values.push(cell(row.get_ref(i)?, limits.max_binary));
                }
                match sink {
                    Some(sink) if sink.failed() => break,
                    Some(sink) => sink.row(&values),
                    None => result.rows.push(values),
                }
            }
        }
        if let Some(sink) = sink {
            sink.finish();
        }
        out.push(result);
    }
    Ok(())
}

/// D1 returns BLOBs as arrays of byte values.
fn d1_cell(value: &Value, max_binary: usize) -> Value {
    match value {
        Value::Null => Value::Null,
        Value::String(s) => Value::String(s.clone()),
        Value::Number(n) => Value::String(n.to_string()),
        Value::Bool(b) => Value::Bool(*b),
        Value::Array(items) if items.iter().all(|i| i.as_u64().is_some_and(|b| b < 256)) => {
            let bytes: Vec<u8> = items
                .iter()
                .filter_map(|i| i.as_u64())
                .map(|b| b as u8)
                .collect();
            Value::String(hex_bytes_max(&bytes, max_binary))
        }
        other => Value::String(other.to_string()),
    }
}

/// The `/raw` response: per statement, `results: { columns, rows }` and `meta`.
fn parse_d1(response: &Value, max_rows: usize, max_binary: usize) -> Vec<StatementResult> {
    let statements = response["result"].as_array().cloned().unwrap_or_default();
    statements
        .iter()
        .map(|statement| {
            let columns: Vec<ColumnMeta> = statement["results"]["columns"]
                .as_array()
                .map(|cols| {
                    cols.iter()
                        .map(|c| ColumnMeta {
                            name: c.as_str().unwrap_or("").to_string(),
                            type_name: String::new(),
                        })
                        .collect()
                })
                .unwrap_or_default();
            let all_rows = statement["results"]["rows"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let rows = all_rows
                .iter()
                .take(max_rows)
                .map(|r| {
                    r.as_array()
                        .map(|r| r.iter().map(|v| d1_cell(v, max_binary)).collect())
                        .unwrap_or_default()
                })
                .collect();
            let changed = statement["meta"]["changed_db"].as_bool().unwrap_or(false);
            let changes = statement["meta"]["changes"].as_u64();
            StatementResult {
                total: all_rows.len() as u64,
                changes: if columns.is_empty() && changed {
                    changes
                } else {
                    None
                },
                columns,
                rows,
            }
        })
        .collect()
}

impl Backend {
    async fn run(&self, sql: &str, limits: RunLimits) -> (Vec<StatementResult>, Option<AppError>) {
        match self {
            Backend::File { conn, .. } => {
                let conn = conn.clone();
                let sql = sql.to_string();
                let joined = tokio::task::spawn_blocking(move || {
                    let guard = conn.lock().unwrap_or_else(|p| p.into_inner());
                    let mut out = Vec::new();
                    let error = run_file(&guard, &sql, &limits, &mut out).err();
                    (out, error)
                })
                .await;
                match joined {
                    Ok((out, error)) => (out, error.map(sqlite_error)),
                    Err(e) => (Vec::new(), Some(AppError::msg(e.to_string()))),
                }
            }
            Backend::D1(d1) => {
                let Some(sql) = d1_script(sql) else {
                    return (Vec::new(), None);
                };
                let path = format!("/accounts/{}/d1/database/{}/raw", d1.account, d1.database);
                let body = serde_json::json!({ "sql": sql });
                match cloud::api(
                    Provider::Cloudflare,
                    "POST",
                    &path,
                    Some(body),
                    Some(&d1.token),
                )
                .await
                {
                    Ok(response) => (
                        parse_d1(&response, limits.max_rows, limits.max_binary),
                        None,
                    ),
                    Err(e) => (Vec::new(), Some(e)),
                }
            }
        }
    }
}

impl SqSession {
    fn is_d1(&self) -> bool {
        matches!(self.backend, Backend::D1(_))
    }

    /// D1 runs each request on its own, so only local files hold transactions open.
    pub fn in_transaction(&self) -> Option<bool> {
        match &self.backend {
            Backend::File { conn, .. } => Some(!conn.lock().ok()?.is_autocommit()),
            Backend::D1(_) => None,
        }
    }

    /// The first result set of a metadata query.
    async fn query(&self, sql: &str) -> AppResult<Vec<Vec<Value>>> {
        let (mut results, error) = self.backend.run(sql, RunLimits::all()).await;
        if let Some(e) = error {
            return Err(e);
        }
        Ok(if results.is_empty() {
            Vec::new()
        } else {
            results.swap_remove(0).rows
        })
    }

    pub async fn server_info(&mut self) -> AppResult<ServerInfo> {
        // D1's authorizer rejects sqlite_version(), so a trivial query proves the
        // credentials instead and the version stays unknown
        if self.is_d1() {
            self.query("SELECT 1").await?;
            return Ok(ServerInfo {
                product: "Cloudflare D1".into(),
                version: "Cloudflare D1".into(),
                current_database: MAIN.into(),
                user: String::new(),
                babelfish_version: None,
            });
        }
        let version = self
            .query("SELECT sqlite_version()")
            .await?
            .first()
            .and_then(|r| text(r, 0))
            .unwrap_or_default();
        Ok(ServerInfo {
            product: format!("SQLite {version}"),
            version: format!("SQLite {version}"),
            current_database: MAIN.into(),
            user: String::new(),
            babelfish_version: None,
        })
    }

    pub async fn list_databases(&mut self) -> AppResult<Vec<DatabaseInfo>> {
        // D1 doesn't document the page pragmas, so a size is a bonus
        let size = self
            .query("SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()")
            .await
            .ok()
            .and_then(|rows| rows.first().and_then(|r| text(r, 0)))
            .and_then(|s| s.parse().ok());
        Ok(vec![DatabaseInfo {
            name: MAIN.into(),
            is_system: false,
            size_bytes: size,
        }])
    }

    pub async fn list_objects(&mut self) -> AppResult<Vec<DbObject>> {
        let rows = self
            .query(
                "SELECT type, name FROM sqlite_master \
                 WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' \
                 AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name",
            )
            .await?;
        Ok(rows
            .iter()
            .filter_map(|r| {
                Some(DbObject {
                    schema: None,
                    kind: text(r, 0)?,
                    name: text(r, 1)?,
                    detail: None,
                    comment: None,
                    row_estimate: None,
                })
            })
            .collect())
    }

    pub async fn describe_table(&mut self, table: &str) -> AppResult<TableInfo> {
        let columns_rows = self
            .query(&format!("PRAGMA table_info({})", ident(table)))
            .await?;
        // cid, name, type, notnull, dflt_value, pk
        let mut pk: Vec<(i64, String)> = Vec::new();
        let mut columns: Vec<ColumnInfo> = columns_rows
            .iter()
            .map(|r| {
                let name = text(r, 1).unwrap_or_default();
                let key = int(r, 5);
                if key > 0 {
                    pk.push((key, name.clone()));
                }
                ColumnInfo {
                    data_type: text(r, 2).unwrap_or_default(),
                    nullable: int(r, 3) == 0,
                    default: text(r, 4),
                    is_primary_key: key > 0,
                    name,
                    ..Default::default()
                }
            })
            .collect();
        pk.sort();
        let primary_key: Vec<String> = pk.into_iter().map(|(_, n)| n).collect();
        // A lone INTEGER PRIMARY KEY is the rowid, which SQLite fills in
        if primary_key.len() == 1
            && let Some(col) = columns.iter_mut().find(|c| c.name == primary_key[0])
            && col.data_type.eq_ignore_ascii_case("integer")
        {
            col.is_identity = true;
            col.is_generated = true;
        }

        let mut indexes = Vec::new();
        for r in self
            .query(&format!("PRAGMA index_list({})", ident(table)))
            .await?
        {
            // seq, name, unique, origin, partial
            let Some(name) = text(&r, 1) else { continue };
            let cols = self
                .query(&format!("PRAGMA index_info({})", ident(&name)))
                .await?
                .iter()
                .filter_map(|c| text(c, 2))
                .collect();
            let definition = self
                .query(&format!(
                    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = {}",
                    literal(&name)
                ))
                .await?
                .first()
                .and_then(|row| text(row, 0));
            indexes.push(IndexInfo {
                primary: text(&r, 3).as_deref() == Some("pk"),
                unique: int(&r, 2) == 1,
                name,
                columns: cols,
                method: None,
                definition,
            });
        }

        // id, seq, table, from, to, on_update, on_delete, match
        let mut foreign_keys: Vec<(i64, ForeignKeyInfo)> = Vec::new();
        for r in self
            .query(&format!("PRAGMA foreign_key_list({})", ident(table)))
            .await?
        {
            let id = int(&r, 0);
            let from = text(&r, 3).unwrap_or_default();
            let to = text(&r, 4).unwrap_or_default();
            match foreign_keys.iter_mut().find(|(i, _)| *i == id) {
                Some((_, fk)) => {
                    fk.columns.push(from);
                    fk.ref_columns.push(to);
                }
                None => foreign_keys.push((
                    id,
                    ForeignKeyInfo {
                        name: format!("fk_{table}_{id}"),
                        columns: vec![from],
                        ref_schema: None,
                        ref_table: text(&r, 2).unwrap_or_default(),
                        ref_columns: vec![to],
                        on_update: text(&r, 5),
                        on_delete: text(&r, 6),
                    },
                )),
            }
        }

        let triggers = self
            .query(&format!(
                "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = {} \
                 ORDER BY name",
                literal(table)
            ))
            .await?
            .iter()
            .filter_map(|r| {
                let name = text(r, 0)?;
                let sql = text(r, 1).unwrap_or_default();
                let (timing, events) = trigger_shape(&sql);
                Some(TriggerInfo {
                    name,
                    timing,
                    events,
                    row_level: true,
                    enabled: true,
                    definition: Some(sql),
                })
            })
            .collect();

        Ok(TableInfo {
            columns,
            primary_key,
            indexes,
            foreign_keys: foreign_keys.into_iter().map(|(_, fk)| fk).collect(),
            triggers,
        })
    }

    pub async fn object_definition(&mut self, name: &str) -> AppResult<Option<String>> {
        Ok(self
            .query(&format!(
                "SELECT sql FROM sqlite_master WHERE name = {}",
                literal(name)
            ))
            .await?
            .first()
            .and_then(|r| text(r, 0))
            .map(|sql| format!("{sql};")))
    }

    pub async fn completion(&mut self) -> AppResult<Vec<CompletionTable>> {
        let objects = self.list_objects().await?;
        // One query where table-valued pragmas work (local files), one per table otherwise
        let joined = self
            .query(
                "SELECT m.name, p.name FROM sqlite_master m, pragma_table_info(m.name) p \
                 WHERE m.type IN ('table', 'view') ORDER BY m.name, p.cid",
            )
            .await;
        let mut tables = Vec::with_capacity(objects.len());
        match joined {
            Ok(rows) => {
                for object in objects {
                    let columns = rows
                        .iter()
                        .filter(|r| text(r, 0).as_deref() == Some(object.name.as_str()))
                        .filter_map(|r| text(r, 1))
                        .collect();
                    tables.push(CompletionTable {
                        schema: None,
                        name: object.name,
                        columns,
                        foreign_keys: Vec::new(),
                    });
                }
            }
            Err(_) => {
                for object in objects {
                    let columns = self
                        .query(&format!("PRAGMA table_info({})", ident(&object.name)))
                        .await
                        .unwrap_or_default()
                        .iter()
                        .filter_map(|r| text(r, 1))
                        .collect();
                    tables.push(CompletionTable {
                        schema: None,
                        name: object.name,
                        columns,
                        foreign_keys: Vec::new(),
                    });
                }
            }
        }
        // Join suggestions are a bonus; a key naming no column means the parent's primary key, skipped
        if let Ok(keys) = self
            .query(
                "SELECT m.name, f.id, f.\"from\", f.\"table\", f.\"to\" \
                 FROM sqlite_master m, pragma_foreign_key_list(m.name) f \
                 WHERE m.type = 'table' AND f.\"to\" IS NOT NULL ORDER BY m.name, f.id, f.seq",
            )
            .await
        {
            attach_keys(
                &mut tables,
                keys.iter()
                    .map(|r| KeyColumn {
                        schema: None,
                        table: text(r, 0).unwrap_or_default(),
                        key: text(r, 1).unwrap_or_default(),
                        column: text(r, 2).unwrap_or_default(),
                        ref_schema: None,
                        ref_table: text(r, 3).unwrap_or_default(),
                        ref_column: text(r, 4).unwrap_or_default(),
                    })
                    .collect(),
            );
        }
        Ok(tables)
    }

    pub async fn execute(
        &mut self,
        sql: &str,
        opts: &ExecOptions,
        cancel: &CancelSignal,
    ) -> ExecOutput {
        // A local file streams the export's rows itself (see run_file); D1 answers
        // in one response, which goes through the builder like any other
        let file_sink = !self.is_d1() && opts.sink.is_some();
        let mut out = if file_sink {
            OutputBuilder::new(&ExecOptions {
                sink: None,
                ..opts.clone()
            })
        } else {
            OutputBuilder::new(opts)
        };
        let limits = RunLimits {
            max_rows: if opts.sink.is_some() && self.is_d1() {
                usize::MAX
            } else {
                opts.max_rows.max(1)
            },
            max_binary: opts.max_binary_bytes.max(1),
            sink: opts.sink.clone().filter(|_| file_sink),
        };
        let run = self.backend.run(sql, limits);
        let (results, error) = tokio::select! {
            r = run => r,
            _ = cancel.wait() => {
                // A local query stops at the next step; D1 can't be stopped, only abandoned
                if let Backend::File { interrupt, .. } = &self.backend {
                    interrupt.interrupt();
                }
                out.cancelled = true;
                return out.finish(Some(MAIN.into()));
            }
        };
        for result in results {
            if result.columns.is_empty() {
                if let Some(n) = result.changes {
                    out.affected(n);
                }
                continue;
            }
            out.begin_set(result.columns);
            let shown = result.rows.len() as u64;
            for row in result.rows {
                out.push_row(row);
            }
            for _ in shown..result.total {
                out.skip_row();
            }
            out.end_set(None);
        }
        if let Some(e) = error {
            if cancel.is_fired() {
                out.cancelled = true;
            } else {
                out.fail(e.to_string(), None, None);
            }
        }
        out.finish(Some(MAIN.into()))
    }
}

/// Timing and events out of a CREATE TRIGGER statement.
fn trigger_shape(sql: &str) -> (String, Vec<String>) {
    let upper = sql.to_ascii_uppercase();
    let words: Vec<&str> = upper.split_whitespace().collect();
    let timing = if upper.contains(" INSTEAD OF ") {
        "INSTEAD OF"
    } else if words.contains(&"BEFORE") {
        "BEFORE"
    } else {
        // SQLite's default timing
        "AFTER"
    };
    let event = ["INSERT", "UPDATE", "DELETE"]
        .into_iter()
        .filter(|e| words.contains(e))
        .min_by_key(|e| words.iter().position(|w| w == e).unwrap_or(usize::MAX))
        .unwrap_or("INSERT");
    (timing.to_string(), vec![event.to_string()])
}

/// D1 runs each request's statements as one atomic batch and rejects explicit
/// transactions, so a `BEGIN … COMMIT` script (pending grid edits) is sent
/// without them, and a lone `ROLLBACK` (after a failed batch, which left nothing
/// to undo) runs nothing.
fn d1_script(sql: &str) -> Option<String> {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    let upper = trimmed.to_ascii_uppercase();
    if upper == "ROLLBACK" || upper == "ROLLBACK TRANSACTION" {
        return None;
    }
    let mut body = trimmed;
    for opener in ["BEGIN TRANSACTION;", "BEGIN;"] {
        if upper.starts_with(opener) {
            body = &body[opener.len()..];
            break;
        }
    }
    let upper_body = body.to_ascii_uppercase();
    for closer in ["COMMIT TRANSACTION", "COMMIT", "END TRANSACTION", "END"] {
        let trailing = upper_body.trim_end();
        if body.len() != trimmed.len() && trailing.ends_with(closer) {
            let cut = trailing.len() - closer.len();
            body = body[..cut].trim_end().trim_end_matches(';');
            break;
        }
    }
    Some(body.trim().to_string())
}

fn ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn text(row: &[Value], i: usize) -> Option<String> {
    match row.get(i)? {
        Value::String(s) => Some(s.clone()),
        Value::Null => None,
        other => Some(other.to_string()),
    }
}

fn int(row: &[Value], i: usize) -> i64 {
    text(row, i).and_then(|s| s.parse().ok()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn session(setup: &str) -> (SqSession, tempfile_path::TempPath) {
        let path = tempfile_path::TempPath::new();
        {
            let conn = rusqlite::Connection::open(&path.0).unwrap();
            conn.execute_batch(setup).unwrap();
        }
        let cfg: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "t", "name": "t", "engine": "sqlite", "host": path.0.display().to_string()
        }))
        .unwrap();
        (connect(&cfg, None).await.unwrap(), path)
    }

    /// A temp file removed on drop, without pulling in a crate for it.
    mod tempfile_path {
        pub struct TempPath(pub std::path::PathBuf);
        impl TempPath {
            pub fn new() -> Self {
                Self(std::env::temp_dir().join(format!("dbms-test-{}.db", uuid::Uuid::new_v4())))
            }
        }
        impl Drop for TempPath {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }
    }

    const SCHEMA: &str = "
        CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE books (
            id INTEGER PRIMARY KEY,
            author_id INTEGER REFERENCES authors(id) ON DELETE CASCADE,
            title TEXT DEFAULT 'untitled',
            cover BLOB
        );
        CREATE UNIQUE INDEX books_title ON books(title);
        CREATE VIEW titles AS SELECT title FROM books;
        CREATE TRIGGER books_touch BEFORE UPDATE ON books BEGIN SELECT 1; END;
        INSERT INTO authors (name) VALUES ('Le Guin'), ('Herbert');
        INSERT INTO books (author_id, title, cover) VALUES (1, 'Lathe', x'CAFE');
    ";

    #[tokio::test]
    async fn browses_a_local_file() {
        let (mut s, _path) = session(SCHEMA).await;
        let info = s.server_info().await.unwrap();
        assert!(info.product.starts_with("SQLite 3."));
        assert_eq!(info.current_database, "main");
        let objects = s.list_objects().await.unwrap();
        let names: Vec<_> = objects
            .iter()
            .map(|o| (o.kind.as_str(), o.name.as_str()))
            .collect();
        assert_eq!(
            names,
            [("table", "authors"), ("table", "books"), ("view", "titles")]
        );

        let books = s.describe_table("books").await.unwrap();
        assert_eq!(books.primary_key, ["id"]);
        let id = &books.columns[0];
        assert!(id.is_identity && id.is_primary_key);
        assert_eq!(books.columns[2].default.as_deref(), Some("'untitled'"));
        assert_eq!(books.indexes.len(), 1);
        assert_eq!(books.indexes[0].columns, ["title"]);
        assert!(books.indexes[0].unique);
        assert_eq!(books.foreign_keys[0].ref_table, "authors");
        assert_eq!(books.foreign_keys[0].on_delete.as_deref(), Some("CASCADE"));
        assert_eq!(books.triggers[0].timing, "BEFORE");
        assert_eq!(books.triggers[0].events, ["UPDATE"]);

        let ddl = s.object_definition("titles").await.unwrap().unwrap();
        assert!(ddl.starts_with("CREATE VIEW titles"));
        let completion = s.completion().await.unwrap();
        assert_eq!(completion[0].columns, ["id", "name"]);
        let books = completion.iter().find(|t| t.name == "books").unwrap();
        assert_eq!(books.foreign_keys[0].ref_table, "authors");
        assert_eq!(books.foreign_keys[0].columns, ["author_id"]);
        assert_eq!(books.foreign_keys[0].ref_columns, ["id"]);
    }

    #[tokio::test]
    async fn executes_scripts_with_results_and_errors() {
        let (mut s, _path) = session(SCHEMA).await;
        let opts = ExecOptions::with_max_rows(1);
        let out = s
            .execute(
                "UPDATE authors SET name = upper(name); SELECT id, name FROM authors; SELECT cover FROM books;",
                &opts,
                &CancelSignal::default(),
            )
            .await;
        assert!(out.error.is_none());
        assert_eq!(out.results.len(), 2);
        assert_eq!(out.results[0].row_count, 2);
        assert!(out.results[0].truncated);
        assert_eq!(out.results[0].rows[0][1], Value::String("LE GUIN".into()));
        assert_eq!(out.results[1].rows[0][0], Value::String("0xCAFE".into()));
        assert!(out.messages.iter().any(|m| m.text == "(2 rows affected)"));

        let failed = s
            .execute(
                "SELECT 1; SELECT * FROM missing;",
                &opts,
                &CancelSignal::default(),
            )
            .await;
        assert_eq!(failed.results.len(), 1);
        assert!(
            failed
                .error
                .unwrap()
                .message
                .contains("no such table: missing")
        );
    }

    #[tokio::test]
    async fn missing_files_are_not_created() {
        let cfg: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "t", "name": "t", "engine": "sqlite", "host": "Z:/nope/missing.db"
        }))
        .unwrap();
        let err = connect(&cfg, None).await.err().unwrap();
        assert!(err.to_string().contains("No database file"));
    }

    #[test]
    fn reads_d1_raw_responses() {
        let response = serde_json::json!({
            "success": true,
            "result": [
                { "results": { "columns": ["id", "data"], "rows": [[1, [202, 254]], [2, null]] },
                  "meta": { "changed_db": false, "changes": 0 }, "success": true },
                { "results": { "columns": [], "rows": [] },
                  "meta": { "changed_db": true, "changes": 3 }, "success": true }
            ]
        });
        let results = parse_d1(&response, 1, 4096);
        assert_eq!(results[0].total, 2);
        assert_eq!(
            results[0].rows,
            vec![vec![
                Value::String("1".into()),
                Value::String("0xCAFE".into())
            ]]
        );
        assert_eq!(results[1].changes, Some(3));
    }

    #[test]
    fn d1_drops_transaction_wrappers() {
        assert_eq!(
            d1_script(
                "BEGIN;
UPDATE t SET a = 1;
DELETE FROM t WHERE b = 2;
COMMIT;"
            )
            .as_deref(),
            Some(
                "UPDATE t SET a = 1;
DELETE FROM t WHERE b = 2"
            )
        );
        assert_eq!(d1_script("ROLLBACK").as_deref(), None);
        assert_eq!(d1_script("SELECT 1;").as_deref(), Some("SELECT 1"));
        // Only a script that opened a transaction loses its closing COMMIT
        assert_eq!(d1_script("SELECT 'END'").as_deref(), Some("SELECT 'END'"));
    }

    #[test]
    fn trigger_shapes() {
        assert_eq!(
            trigger_shape("CREATE TRIGGER t INSTEAD OF DELETE ON v BEGIN SELECT 1; END"),
            ("INSTEAD OF".into(), vec!["DELETE".into()])
        );
        assert_eq!(
            trigger_shape("create trigger t after insert on x begin update x set a = 1; end"),
            ("AFTER".into(), vec!["INSERT".into()])
        );
    }

    /// Collects what an export would write.
    struct Collect(std::sync::Arc<parking_lot::Mutex<Vec<Vec<Value>>>>);

    impl RowSink for Collect {
        fn begin(&mut self, columns: &[ColumnMeta]) -> std::io::Result<()> {
            let names = columns
                .iter()
                .map(|c| Value::String(c.name.clone()))
                .collect();
            self.0.lock().push(names);
            Ok(())
        }
        fn row(&mut self, row: &[Value]) -> std::io::Result<()> {
            self.0.lock().push(row.to_vec());
            Ok(())
        }
        fn finish(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn streams_one_result_set_past_the_row_limit() {
        let (mut s, _path) = session(SCHEMA).await;
        let written = std::sync::Arc::default();
        let opts = ExecOptions {
            max_rows: 1,
            max_binary_bytes: 1,
            sink: Some(SinkHandle::new(
                Box::new(Collect(std::sync::Arc::clone(&written))),
                1,
            )),
            read_only: false,
        };
        let out = s
            .execute(
                "SELECT 1; SELECT id, name FROM authors ORDER BY id; SELECT cover FROM books;",
                &opts,
                &CancelSignal::default(),
            )
            .await;
        assert!(out.error.is_none());
        assert_eq!(out.results.len(), 3);
        // The exported set went to the sink, not the output
        assert!(out.results[1].rows.is_empty());
        assert_eq!(out.results[1].row_count, 2);
        assert_eq!(
            *written.lock(),
            vec![
                vec![Value::String("id".into()), Value::String("name".into())],
                vec![Value::String("1".into()), Value::String("Le Guin".into())],
                vec![Value::String("2".into()), Value::String("Herbert".into())],
            ]
        );
        // Other sets keep the grid's limits
        assert_eq!(
            out.results[2].rows[0][0],
            Value::String("0xCA… (2 bytes)".into())
        );
    }
}
