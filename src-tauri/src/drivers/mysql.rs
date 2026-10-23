//! MySQL / MariaDB via mysql_async. Ad-hoc queries use the text protocol so
//! multi-statement scripts and every column type round-trip as text.

use std::time::Duration;

use mysql_async::consts::ColumnType;
use mysql_async::prelude::*;
use mysql_async::{Column, Conn, Opts, OptsBuilder, Row, SslOpts, Value as MyValue};
use serde_json::Value;

use crate::config::{ConnectionConfig, SslMode};
use crate::error::{AppError, AppResult};
use crate::model::*;

pub struct MySession {
    conn: Conn,
    opts: Opts,
    pub database: String,
}

pub fn describe_error(e: &mysql_async::Error) -> String {
    match e {
        mysql_async::Error::Server(s) => format!("ERROR {} ({}): {}", s.code, s.state, s.message),
        other => other.to_string(),
    }
}

fn build_opts(cfg: &ConnectionConfig, password: Option<&str>, database: &str, tls: bool) -> Opts {
    let mut builder = OptsBuilder::default()
        .ip_or_hostname(cfg.host.clone())
        .tcp_port(if cfg.port == 0 { 3306 } else { cfg.port })
        .user(Some(cfg.user.clone()))
        .pass(password.map(str::to_string))
        .db_name((!database.is_empty()).then(|| database.to_string()))
        .prefer_socket(false)
        .wait_timeout(Some(28_800));
    if tls {
        let verify = cfg.ssl == SslMode::Require && !cfg.trust_server_certificate;
        builder = builder.ssl_opts(Some(
            SslOpts::default()
                .with_danger_accept_invalid_certs(!verify)
                .with_danger_skip_domain_validation(!verify),
        ));
    }
    builder.into()
}

async fn open(opts: Opts) -> AppResult<Conn> {
    match tokio::time::timeout(Duration::from_secs(15), Conn::new(opts)).await {
        Ok(conn) => Ok(conn?),
        Err(_) => Err(AppError::msg("Timed out connecting to the server")),
    }
}

pub async fn connect(
    cfg: &ConnectionConfig,
    password: Option<&str>,
    database: &str,
) -> AppResult<MySession> {
    let (conn, opts) = match cfg.ssl {
        SslMode::Disable => {
            let opts = build_opts(cfg, password, database, false);
            (open(opts.clone()).await?, opts)
        }
        SslMode::Require => {
            let opts = build_opts(cfg, password, database, true);
            (open(opts.clone()).await?, opts)
        }
        // Try TLS first and fall back to plain text when the server doesn't offer it
        SslMode::Prefer => {
            let opts = build_opts(cfg, password, database, true);
            match open(opts.clone()).await {
                Ok(conn) => (conn, opts),
                Err(e) if is_tls_error(&e.to_string()) => {
                    let opts = build_opts(cfg, password, database, false);
                    (open(opts.clone()).await?, opts)
                }
                Err(e) => return Err(e),
            }
        }
    };
    let mut session = MySession {
        conn,
        opts,
        database: String::new(),
    };
    if cfg.read_only {
        session
            .conn
            .query_drop("SET SESSION TRANSACTION READ ONLY")
            .await?;
    }
    session.refresh_database().await;
    Ok(session)
}

fn is_tls_error(message: &str) -> bool {
    let m = message.to_lowercase();
    m.contains("tls") || m.contains("ssl") || m.contains("certificate")
}

fn type_name(col: &Column) -> &'static str {
    let binary = col.character_set() == 63;
    match col.column_type() {
        ColumnType::MYSQL_TYPE_DECIMAL | ColumnType::MYSQL_TYPE_NEWDECIMAL => "decimal",
        ColumnType::MYSQL_TYPE_TINY => "tinyint",
        ColumnType::MYSQL_TYPE_SHORT => "smallint",
        ColumnType::MYSQL_TYPE_INT24 => "mediumint",
        ColumnType::MYSQL_TYPE_LONG => "int",
        ColumnType::MYSQL_TYPE_LONGLONG => "bigint",
        ColumnType::MYSQL_TYPE_FLOAT => "float",
        ColumnType::MYSQL_TYPE_DOUBLE => "double",
        ColumnType::MYSQL_TYPE_NULL => "null",
        ColumnType::MYSQL_TYPE_TIMESTAMP | ColumnType::MYSQL_TYPE_TIMESTAMP2 => "timestamp",
        ColumnType::MYSQL_TYPE_DATE | ColumnType::MYSQL_TYPE_NEWDATE => "date",
        ColumnType::MYSQL_TYPE_TIME | ColumnType::MYSQL_TYPE_TIME2 => "time",
        ColumnType::MYSQL_TYPE_DATETIME | ColumnType::MYSQL_TYPE_DATETIME2 => "datetime",
        ColumnType::MYSQL_TYPE_YEAR => "year",
        ColumnType::MYSQL_TYPE_BIT => "bit",
        ColumnType::MYSQL_TYPE_JSON => "json",
        ColumnType::MYSQL_TYPE_ENUM => "enum",
        ColumnType::MYSQL_TYPE_SET => "set",
        ColumnType::MYSQL_TYPE_GEOMETRY => "geometry",
        ColumnType::MYSQL_TYPE_VECTOR => "vector",
        ColumnType::MYSQL_TYPE_TINY_BLOB
        | ColumnType::MYSQL_TYPE_MEDIUM_BLOB
        | ColumnType::MYSQL_TYPE_LONG_BLOB
        | ColumnType::MYSQL_TYPE_BLOB => {
            if binary {
                "blob"
            } else {
                "text"
            }
        }
        ColumnType::MYSQL_TYPE_VARCHAR | ColumnType::MYSQL_TYPE_VAR_STRING => {
            if binary {
                "varbinary"
            } else {
                "varchar"
            }
        }
        ColumnType::MYSQL_TYPE_STRING => {
            if binary {
                "binary"
            } else {
                "char"
            }
        }
        _ => "",
    }
}

fn cell(value: &MyValue, col: &Column) -> Value {
    match value {
        MyValue::NULL => Value::Null,
        MyValue::Bytes(bytes) => match col.column_type() {
            ColumnType::MYSQL_TYPE_BIT => {
                let n = bytes.iter().fold(0u64, |acc, b| (acc << 8) | u64::from(*b));
                Value::String(n.to_string())
            }
            ColumnType::MYSQL_TYPE_GEOMETRY => Value::String(hex_bytes(bytes)),
            _ if col.character_set() == 63
                && matches!(type_name(col), "blob" | "varbinary" | "binary" | "vector") =>
            {
                Value::String(hex_bytes(bytes))
            }
            _ => Value::String(String::from_utf8_lossy(bytes).into_owned()),
        },
        MyValue::Int(n) => Value::String(n.to_string()),
        MyValue::UInt(n) => Value::String(n.to_string()),
        MyValue::Float(n) => Value::String(n.to_string()),
        MyValue::Double(n) => Value::String(n.to_string()),
        MyValue::Date(y, mo, d, h, mi, s, us) => Value::String(if *us > 0 {
            format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}.{us:06}")
        } else {
            format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}")
        }),
        MyValue::Time(neg, days, h, mi, s, us) => {
            let hours = u32::from(*h) + days * 24;
            let sign = if *neg { "-" } else { "" };
            Value::String(if *us > 0 {
                format!("{sign}{hours:02}:{mi:02}:{s:02}.{us:06}")
            } else {
                format!("{sign}{hours:02}:{mi:02}:{s:02}")
            })
        }
    }
}

/// Converts any cell of a metadata row to an optional string.
fn text(row: &Row, i: usize) -> Option<String> {
    let value = row.as_ref(i)?;
    match value {
        MyValue::NULL => None,
        MyValue::Bytes(b) => Some(String::from_utf8_lossy(b).into_owned()),
        MyValue::Int(n) => Some(n.to_string()),
        MyValue::UInt(n) => Some(n.to_string()),
        MyValue::Float(n) => Some(n.to_string()),
        MyValue::Double(n) => Some(n.to_string()),
        other => Some(format!("{other:?}")),
    }
}

/// Interrupts the statement running on connection `thread_id` from a second connection.
fn kill_query(opts: Opts, thread_id: u32) {
    tokio::spawn(async move {
        if let Ok(mut killer) = Conn::new(opts).await {
            let _ = killer.query_drop(format!("KILL QUERY {thread_id}")).await;
            let _ = killer.disconnect().await;
        }
    });
}

fn quote_ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

impl MySession {
    async fn refresh_database(&mut self) {
        if let Ok(Some(db)) = self
            .conn
            .query_first::<Option<String>, _>("SELECT DATABASE()")
            .await
        {
            self.database = db.unwrap_or_default();
        }
    }

    pub async fn ping(&mut self) -> bool {
        self.conn.ping().await.is_ok()
    }

    pub async fn use_database(&mut self, database: &str) -> AppResult<()> {
        if database.is_empty() || database == self.database {
            return Ok(());
        }
        self.conn
            .query_drop(format!("USE {}", quote_ident(database)))
            .await?;
        self.database = database.to_string();
        Ok(())
    }

    pub async fn server_info(&mut self) -> AppResult<ServerInfo> {
        let row: Option<Row> = self
            .conn
            .query_first("SELECT VERSION(), DATABASE(), CURRENT_USER(), @@version_comment")
            .await?;
        let row = row.ok_or_else(|| AppError::msg("Server returned no version"))?;
        let version = text(&row, 0).unwrap_or_default();
        let comment = text(&row, 3).unwrap_or_default();
        let product = if version.to_lowercase().contains("mariadb") {
            format!("MariaDB {}", version.split('-').next().unwrap_or(&version))
        } else {
            format!("MySQL {}", version.split('-').next().unwrap_or(&version))
        };
        Ok(ServerInfo {
            product,
            version: format!("{version} {comment}").trim().to_string(),
            current_database: text(&row, 1).unwrap_or_default(),
            user: text(&row, 2).unwrap_or_default(),
            babelfish_version: None,
        })
    }

    pub async fn execute(
        &mut self,
        sql: &str,
        opts: &ExecOptions,
        cancel: &CancelSignal,
    ) -> ExecOutput {
        let mut out = OutputBuilder::new(opts);
        let warnings = match self.run(sql, &mut out, cancel).await {
            Ok(w) => w,
            Err(e) => {
                let message = describe_error(&e);
                if out.cancelled {
                    out.message("warning", message);
                } else {
                    out.fail(message, None, None);
                }
                0
            }
        };
        if warnings > 0
            && let Ok(rows) = self.conn.query::<Row, _>("SHOW WARNINGS").await
        {
            for row in rows {
                out.message(
                    "warning",
                    format!(
                        "{} {}: {}",
                        text(&row, 0).unwrap_or_default(),
                        text(&row, 1).unwrap_or_default(),
                        text(&row, 2).unwrap_or_default()
                    ),
                );
            }
        }
        self.refresh_database().await;
        out.finish(Some(self.database.clone()))
    }

    /// Returns the warning count of the last statement.
    async fn run(
        &mut self,
        sql: &str,
        out: &mut OutputBuilder,
        cancel: &CancelSignal,
    ) -> Result<u16, mysql_async::Error> {
        let thread_id = self.conn.id();
        let opts = self.opts.clone();
        // The server answers only once the first statement finishes, so watch for
        // cancellation while waiting for the first result too
        let query = self.conn.query_iter(sql);
        tokio::pin!(query);
        let mut result = loop {
            tokio::select! {
                biased;
                _ = cancel.wait(), if !out.cancelled => {
                    out.cancelled = true;
                    kill_query(opts.clone(), thread_id);
                }
                r = &mut query => break r?,
            }
        };
        let mut warnings = 0;
        while let Some(columns) = result.columns() {
            warnings = result.warnings();
            if columns.is_empty() {
                out.affected(result.affected_rows());
                result.next().await?;
            } else {
                out.begin_set(
                    columns
                        .iter()
                        .map(|c| ColumnMeta {
                            name: c.name_str().into_owned(),
                            type_name: type_name(c).to_string(),
                        })
                        .collect(),
                );
                loop {
                    let next = tokio::select! {
                        biased;
                        _ = cancel.wait(), if !out.cancelled => {
                            out.cancelled = true;
                            kill_query(opts.clone(), thread_id);
                            continue;
                        }
                        next = result.next() => next?,
                    };
                    let Some(row) = next else { break };
                    if out.wants_rows() {
                        let values = (0..row.len())
                            .map(|i| match row.as_ref(i) {
                                Some(v) => cell(v, &columns[i]),
                                None => Value::Null,
                            })
                            .collect();
                        out.push_row(values);
                    } else {
                        out.skip_row();
                    }
                }
                out.end_set(None);
            }
        }
        Ok(warnings)
    }

    async fn rows(&mut self, sql: &str, params: Vec<MyValue>) -> AppResult<Vec<Row>> {
        Ok(self.conn.exec(sql, params).await?)
    }

    pub async fn list_databases(&mut self) -> AppResult<Vec<DatabaseInfo>> {
        let rows = self
            .rows(
                "SELECT s.schema_name, \
                   (SELECT SUM(t.data_length + t.index_length) FROM information_schema.tables t \
                    WHERE t.table_schema = s.schema_name) \
                 FROM information_schema.schemata s ORDER BY s.schema_name",
                vec![],
            )
            .await?;
        Ok(rows
            .iter()
            .map(|r| {
                let name = text(r, 0).unwrap_or_default();
                DatabaseInfo {
                    is_system: matches!(
                        name.as_str(),
                        "information_schema" | "mysql" | "performance_schema" | "sys"
                    ),
                    size_bytes: text(r, 1)
                        .and_then(|s| s.parse::<f64>().ok())
                        .map(|n| n as i64),
                    name,
                }
            })
            .collect())
    }

    pub async fn list_objects(&mut self, database: &str) -> AppResult<Vec<DbObject>> {
        let mut objects: Vec<DbObject> = self
            .rows(
                "SELECT table_name, table_type, table_comment, table_rows \
                 FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name",
                vec![database.into()],
            )
            .await?
            .iter()
            .map(|r| {
                let kind = text(r, 1).unwrap_or_default();
                DbObject {
                    schema: None,
                    name: text(r, 0).unwrap_or_default(),
                    kind: if kind.contains("VIEW") {
                        "view"
                    } else {
                        "table"
                    }
                    .to_string(),
                    detail: None,
                    comment: text(r, 2).filter(|c| !c.is_empty()),
                    row_estimate: text(r, 3).and_then(|s| s.parse().ok()),
                }
            })
            .collect();
        let routines = self
            .rows(
                "SELECT routine_name, routine_type FROM information_schema.routines \
                 WHERE routine_schema = ? ORDER BY routine_name",
                vec![database.into()],
            )
            .await?;
        objects.extend(routines.iter().map(|r| {
            DbObject {
                schema: None,
                name: text(r, 0).unwrap_or_default(),
                kind: if text(r, 1).as_deref() == Some("PROCEDURE") {
                    "procedure"
                } else {
                    "function"
                }
                .to_string(),
                detail: None,
                comment: None,
                row_estimate: None,
            }
        }));
        Ok(objects)
    }

    pub async fn describe_table(&mut self, database: &str, table: &str) -> AppResult<TableInfo> {
        let columns = self
            .rows(
                "SELECT column_name, column_type, is_nullable, column_default, column_key, extra, column_comment \
                 FROM information_schema.columns WHERE table_schema = ? AND table_name = ? \
                 ORDER BY ordinal_position",
                vec![database.into(), table.into()],
            )
            .await?;
        let stats = self
            .rows(
                "SELECT index_name, non_unique, column_name, index_type \
                 FROM information_schema.statistics WHERE table_schema = ? AND table_name = ? \
                 ORDER BY index_name = 'PRIMARY' DESC, index_name, seq_in_index",
                vec![database.into(), table.into()],
            )
            .await?;
        let fks = self
            .rows(
                "SELECT k.constraint_name, k.column_name, k.referenced_table_schema, \
                   k.referenced_table_name, k.referenced_column_name, r.update_rule, r.delete_rule \
                 FROM information_schema.key_column_usage k \
                 JOIN information_schema.referential_constraints r \
                   ON r.constraint_schema = k.constraint_schema AND r.constraint_name = k.constraint_name \
                 WHERE k.table_schema = ? AND k.table_name = ? AND k.referenced_table_name IS NOT NULL \
                 ORDER BY k.constraint_name, k.ordinal_position",
                vec![database.into(), table.into()],
            )
            .await?;

        let mut indexes: Vec<IndexInfo> = Vec::new();
        for r in &stats {
            let name = text(r, 0).unwrap_or_default();
            let column = text(r, 2).unwrap_or_default();
            match indexes.iter_mut().find(|i| i.name == name) {
                Some(index) => index.columns.push(column),
                None => indexes.push(IndexInfo {
                    primary: name == "PRIMARY",
                    unique: text(r, 1).as_deref() == Some("0"),
                    method: text(r, 3),
                    columns: vec![column],
                    definition: None,
                    name,
                }),
            }
        }
        let primary_key = indexes
            .iter()
            .find(|i| i.primary)
            .map(|i| i.columns.clone())
            .unwrap_or_default();

        let mut foreign_keys: Vec<ForeignKeyInfo> = Vec::new();
        for r in &fks {
            let name = text(r, 0).unwrap_or_default();
            let column = text(r, 1).unwrap_or_default();
            let ref_column = text(r, 4).unwrap_or_default();
            match foreign_keys.iter_mut().find(|f| f.name == name) {
                Some(fk) => {
                    fk.columns.push(column);
                    fk.ref_columns.push(ref_column);
                }
                None => foreign_keys.push(ForeignKeyInfo {
                    name,
                    columns: vec![column],
                    ref_schema: text(r, 2),
                    ref_table: text(r, 3).unwrap_or_default(),
                    ref_columns: vec![ref_column],
                    on_update: text(r, 5),
                    on_delete: text(r, 6),
                }),
            }
        }

        Ok(TableInfo {
            columns: columns
                .iter()
                .map(|r| {
                    let extra = text(r, 5).unwrap_or_default().to_lowercase();
                    ColumnInfo {
                        name: text(r, 0).unwrap_or_default(),
                        data_type: text(r, 1).unwrap_or_default(),
                        nullable: text(r, 2).as_deref() == Some("YES"),
                        default: text(r, 3),
                        is_primary_key: text(r, 4).as_deref() == Some("PRI"),
                        is_generated: extra.contains("auto_increment")
                            || extra.contains("generated"),
                        comment: text(r, 6).filter(|c| !c.is_empty()),
                    }
                })
                .collect(),
            primary_key,
            indexes,
            foreign_keys,
        })
    }

    pub async fn object_definition(
        &mut self,
        database: &str,
        name: &str,
        kind: &str,
    ) -> AppResult<Option<String>> {
        let target = format!("{}.{}", quote_ident(database), quote_ident(name));
        let (sql, column) = match kind {
            "table" => (format!("SHOW CREATE TABLE {target}"), 1),
            "view" => (format!("SHOW CREATE VIEW {target}"), 1),
            "function" => (format!("SHOW CREATE FUNCTION {target}"), 2),
            "procedure" => (format!("SHOW CREATE PROCEDURE {target}"), 2),
            _ => return Ok(None),
        };
        let row: Option<Row> = self.conn.query_first(sql).await?;
        Ok(row.and_then(|r| text(&r, column)))
    }

    pub async fn completion(&mut self, database: &str) -> AppResult<Vec<CompletionTable>> {
        let rows = self
            .rows(
                "SELECT table_name, column_name FROM information_schema.columns \
                 WHERE table_schema = ? ORDER BY table_name, ordinal_position LIMIT 50000",
                vec![database.into()],
            )
            .await?;
        let mut tables: Vec<CompletionTable> = Vec::new();
        for r in &rows {
            let table = text(r, 0).unwrap_or_default();
            let column = text(r, 1).unwrap_or_default();
            match tables.last_mut() {
                Some(t) if t.name == table => t.columns.push(column),
                _ => tables.push(CompletionTable {
                    schema: None,
                    name: table,
                    columns: vec![column],
                }),
            }
        }
        Ok(tables)
    }
}
