//! MySQL / MariaDB via mysql_async. Ad-hoc queries use the text protocol so
//! multi-statement scripts and every column type round-trip as text.

use mysql_async::consts::ColumnType;
use mysql_async::prelude::*;
use mysql_async::{
    ClientIdentity, Column, Conn, Opts, OptsBuilder, Row, SslOpts, Value as MyValue,
};
use serde_json::Value;

use crate::config::{AuthMode, ConnectionConfig, SslMode};
use crate::error::{AppError, AppResult};
use crate::model::*;

use super::tls::{self, ClientCert};

mod events;

pub struct MySession {
    conn: Conn,
    opts: Opts,
    pub database: String,
    /// Set when the server dropped the connection (KILL, restart, timeout); the
    /// manager reconnects
    pub broken: bool,
}

pub fn describe_error(e: &mysql_async::Error) -> String {
    match e {
        mysql_async::Error::Server(s) => format!("ERROR {} ({}): {}", s.code, s.state, s.message),
        other => other.to_string(),
    }
}

/// CA and client certificate files, read once so reconnects reuse them
fn ssl_opts(cfg: &ConnectionConfig) -> AppResult<SslOpts> {
    let mut ssl = SslOpts::default()
        .with_danger_accept_invalid_certs(!cfg.verify_certificate())
        .with_danger_skip_domain_validation(!cfg.verify_hostname())
        // Through a tunnel the certificate names the real server, not 127.0.0.1
        .with_danger_tls_hostname_override(cfg.tunneled.as_ref().map(|(h, _)| h.clone()));
    if let Some(path) = cfg.root_cert() {
        ssl = ssl.with_root_certs(vec![tls::read_file(path, "CA certificate")?.into()]);
    }
    match tls::client_cert(cfg)? {
        None => {}
        Some(ClientCert::Pkcs12(path)) => {
            ssl = ssl.with_client_identity(Some(ClientIdentity::new(
                tls::read_file(path, "client certificate")?.into(),
            )));
        }
        // mysql_async's native-tls backend only takes PKCS#12 identities
        Some(ClientCert::Pem { .. }) => {
            return Err(AppError::Unsupported(
                "MySQL client certificates must be a PKCS#12 bundle (.p12/.pfx) without a password.                  Create one with `openssl pkcs12 -export -in client.crt -inkey client.key -out client.p12 -passout pass:`,                  choose it as the client certificate and leave the client key empty"
                    .into(),
            ));
        }
    }
    Ok(ssl)
}

fn build_opts(
    cfg: &ConnectionConfig,
    password: Option<&str>,
    database: &str,
    tls: bool,
) -> AppResult<Opts> {
    let mut builder = OptsBuilder::default()
        .ip_or_hostname(cfg.host.clone())
        .tcp_port(if cfg.port == 0 { 3306 } else { cfg.port })
        .user(Some(cfg.user.clone()))
        .pass(password.map(str::to_string))
        .db_name((!database.is_empty()).then(|| database.to_string()))
        .prefer_socket(false)
        .wait_timeout(Some(28_800))
        // IAM tokens are checked by the server's cleartext auth plugin
        .enable_cleartext_plugin(cfg.auth == AuthMode::Cloud);
    if tls {
        builder = builder.ssl_opts(Some(ssl_opts(cfg)?));
    }
    Ok(builder.into())
}

async fn open(opts: Opts) -> AppResult<Conn> {
    let user = opts.user().unwrap_or_default().to_string();
    match tokio::time::timeout(crate::limits::connect_timeout(), Conn::new(opts)).await {
        Ok(conn) => conn.map_err(|e| match super::mysql_auth::connect_error(&e, &user) {
            Some(message) => AppError::Message(message),
            None => e.into(),
        }),
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
            let opts = build_opts(cfg, password, database, false)?;
            (open(opts.clone()).await?, opts)
        }
        SslMode::Require | SslMode::VerifyCa | SslMode::VerifyFull => {
            let opts = build_opts(cfg, password, database, true)?;
            (open(opts.clone()).await?, opts)
        }
        // Try TLS first and fall back to plain text when the server doesn't offer it
        SslMode::Prefer => {
            let opts = build_opts(cfg, password, database, true)?;
            match open(opts.clone()).await {
                Ok(conn) => (conn, opts),
                Err(e) if is_tls_error(&e.to_string()) => {
                    let opts = build_opts(cfg, password, database, false)?;
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
        broken: false,
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

fn cell(value: &MyValue, col: &Column, max_binary: usize) -> Value {
    match value {
        MyValue::NULL => Value::Null,
        MyValue::Bytes(bytes) => match col.column_type() {
            ColumnType::MYSQL_TYPE_BIT => {
                let n = bytes.iter().fold(0u64, |acc, b| (acc << 8) | u64::from(*b));
                Value::String(n.to_string())
            }
            ColumnType::MYSQL_TYPE_GEOMETRY => Value::String(hex_bytes_max(bytes, max_binary)),
            _ if col.character_set() == 63
                && matches!(type_name(col), "blob" | "varbinary" | "binary" | "vector") =>
            {
                Value::String(hex_bytes_max(bytes, max_binary))
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
/// The caller waits for the returned task before sending anything else on that
/// connection, so a late KILL can't land on its next statement.
fn kill_query(opts: Opts, thread_id: u32) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let connect = tokio::time::timeout(crate::limits::connect_timeout(), Conn::new(opts));
        if let Ok(Ok(mut killer)) = connect.await {
            let _ = killer.query_drop(format!("KILL QUERY {thread_id}")).await;
            let _ = killer.disconnect().await;
        }
    })
}

/// Awaits `fut`, which reads from the server, and starts a KILL QUERY the first
/// time `cancel` fires. The future itself keeps running so the reply is still read
/// in order; the kill makes the server end it early.
async fn cancellable<T>(
    fut: impl std::future::Future<Output = T>,
    cancel: &CancelSignal,
    out: &mut OutputBuilder,
    kill: &mut Option<tokio::task::JoinHandle<()>>,
    opts: &Opts,
    thread_id: u32,
) -> T {
    tokio::pin!(fut);
    loop {
        tokio::select! {
            biased;
            _ = cancel.wait(), if !out.cancelled => {
                out.cancelled = true;
                *kill = Some(kill_query(opts.clone(), thread_id));
            }
            r = &mut fut => return r,
        }
    }
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

    /// Read from the status flags of a no-op's OK packet.
    pub async fn in_transaction(&mut self) -> Option<bool> {
        self.conn.query_drop("DO 0").await.ok()?;
        let ok = self.conn.last_ok_packet()?;
        Some(
            ok.status_flags()
                .contains(mysql_async::consts::StatusFlags::SERVER_STATUS_IN_TRANS),
        )
    }

    /// The underlying connection, for the built-in backup's streaming reads.
    pub fn conn(&mut self) -> &mut Conn {
        &mut self.conn
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
                // 1053 shutdown, 1927 killed (MariaDB), 4031 idle disconnect
                self.broken = matches!(&e, mysql_async::Error::Io(_))
                    || matches!(&e, mysql_async::Error::Server(s) if matches!(s.code, 1053 | 1927 | 4031))
                    || self.conn.is_disconnected();
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
        let mut kill = None;
        let result = self.run_statements(sql, out, cancel, &mut kill).await;
        // Let a pending KILL QUERY land before this connection runs anything else;
        // on an idle connection it does nothing
        if let Some(task) = kill {
            let _ = task.await;
        }
        result
    }

    async fn run_statements(
        &mut self,
        sql: &str,
        out: &mut OutputBuilder,
        cancel: &CancelSignal,
        kill: &mut Option<tokio::task::JoinHandle<()>>,
    ) -> Result<u16, mysql_async::Error> {
        let thread_id = self.conn.id();
        let opts = self.opts.clone();
        // Every read from the server waits for a statement to finish (the first
        // result, and the next statement's after each set), so all of them watch
        // for cancellation
        let query = self.conn.query_iter(sql);
        let mut result = cancellable(query, cancel, out, kill, &opts, thread_id).await?;
        let mut warnings = 0;
        while let Some(columns) = result.columns() {
            warnings = result.warnings();
            if columns.is_empty() {
                out.affected(result.affected_rows());
                cancellable(result.next(), cancel, out, kill, &opts, thread_id).await?;
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
                while let Some(row) =
                    cancellable(result.next(), cancel, out, kill, &opts, thread_id).await?
                {
                    if out.wants_rows() {
                        let max = out.max_binary();
                        let values = (0..row.len())
                            .map(|i| match row.as_ref(i) {
                                Some(v) => cell(v, &columns[i], max),
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
                    keys: None,
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
                // MariaDB 10.3+ lists sequences as tables of type SEQUENCE, always with one row
                let sequence = kind == "SEQUENCE";
                DbObject {
                    schema: None,
                    name: text(r, 0).unwrap_or_default(),
                    kind: if kind.contains("VIEW") {
                        "view"
                    } else if sequence {
                        "sequence"
                    } else {
                        "table"
                    }
                    .to_string(),
                    detail: None,
                    comment: text(r, 2).filter(|c| !c.is_empty()),
                    row_estimate: text(r, 3)
                        .and_then(|s| s.parse().ok())
                        .filter(|_| !sequence),
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
        // A MariaDB package's body is shown under its spec's node
        let routines = routines
            .iter()
            .filter(|r| text(r, 1).as_deref() != Some("PACKAGE BODY"));
        objects.extend(routines.map(|r| {
            DbObject {
                schema: None,
                name: text(r, 0).unwrap_or_default(),
                kind: match text(r, 1).as_deref() {
                    Some("PROCEDURE") => "procedure",
                    Some("PACKAGE") => "package",
                    _ => "function",
                }
                .to_string(),
                detail: None,
                comment: None,
                row_estimate: None,
            }
        }));
        // Scheduled events, with their status and schedule as the detail
        let events = self.rows(events::LIST_SQL, vec![database.into()]).await?;
        objects.extend(events.iter().map(events::object));
        Ok(objects)
    }

    pub async fn describe_table(&mut self, database: &str, table: &str) -> AppResult<TableInfo> {
        let columns = self
            .rows(
                "SELECT column_name, column_type, is_nullable, column_default, column_key, extra, column_comment, \
                   character_set_name, collation_name \
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
        let trigger_rows = self
            .rows(
                "SELECT trigger_name, action_timing, event_manipulation, action_statement \
                 FROM information_schema.triggers WHERE event_object_schema = ? AND event_object_table = ? \
                 ORDER BY action_timing, event_manipulation, action_order",
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
                        is_identity: extra.contains("auto_increment"),
                        comment: text(r, 6).filter(|c| !c.is_empty()),
                        extra: text(r, 5).filter(|e| !e.is_empty()),
                        charset: text(r, 7),
                        collation: text(r, 8),
                    }
                })
                .collect(),
            primary_key,
            indexes,
            foreign_keys,
            triggers: trigger_rows
                .iter()
                .map(|r| {
                    let name = text(r, 0).unwrap_or_default();
                    let timing = text(r, 1).unwrap_or_default();
                    let event = text(r, 2).unwrap_or_default();
                    // information_schema only has the body, so restate the header
                    let definition = text(r, 3).map(|body| {
                        format!(
                            "CREATE TRIGGER {} {timing} {event} ON {}.{} FOR EACH ROW\n{body}",
                            quote_ident(&name),
                            quote_ident(database),
                            quote_ident(table),
                        )
                    });
                    TriggerInfo {
                        name,
                        timing,
                        events: vec![event],
                        // MySQL only has row-level triggers
                        row_level: true,
                        enabled: true,
                        definition,
                    }
                })
                .collect(),
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
            "package" => return self.package_definition(&target).await,
            "event" => (format!("SHOW CREATE EVENT {target}"), 3),
            "sequence" => (format!("SHOW CREATE SEQUENCE {target}"), 1),
            _ => return Ok(None),
        };
        let row: Option<Row> = self.conn.query_first(sql).await?;
        Ok(row.and_then(|r| text(&r, column)))
    }

    /// A MariaDB package's spec, then its body when it has one.
    async fn package_definition(&mut self, target: &str) -> AppResult<Option<String>> {
        let spec: Option<Row> = self
            .conn
            .query_first(format!("SHOW CREATE PACKAGE {target}"))
            .await?;
        let Some(spec) = spec.and_then(|r| text(&r, 2)) else {
            return Ok(None);
        };
        let body = match self
            .conn
            .query_first::<Row, _>(format!("SHOW CREATE PACKAGE BODY {target}"))
            .await
        {
            Ok(row) => row.and_then(|r| text(&r, 2)),
            // 1305: the package has no body yet
            Err(mysql_async::Error::Server(e)) if e.code == 1305 => None,
            Err(e) => return Err(e.into()),
        };
        Ok(Some(match body {
            Some(body) => format!("{spec};\n\n{body}"),
            None => spec,
        }))
    }

    pub async fn describe_routine(
        &mut self,
        database: &str,
        name: &str,
        kind: &str,
    ) -> AppResult<RoutineInfo> {
        let routine_type = if kind == "procedure" {
            "PROCEDURE"
        } else {
            "FUNCTION"
        };
        let rows = self
            .rows(
                "SELECT ordinal_position, parameter_name, parameter_mode, dtd_identifier \
                 FROM information_schema.parameters \
                 WHERE specific_schema = ? AND specific_name = ? AND routine_type = ? \
                 ORDER BY ordinal_position",
                vec![database.into(), name.into(), routine_type.into()],
            )
            .await?;
        let mut info = RoutineInfo {
            language: Some("SQL".into()),
            ..Default::default()
        };
        for r in &rows {
            // Position 0 is a function's return value
            if text(r, 0).as_deref() == Some("0") {
                info.returns = text(r, 3);
                continue;
            }
            info.params.push(RoutineParam {
                name: text(r, 1).unwrap_or_default(),
                mode: text(r, 2).unwrap_or_else(|| "IN".into()),
                data_type: text(r, 3).unwrap_or_default(),
            });
        }
        Ok(info)
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
                    foreign_keys: Vec::new(),
                }),
            }
        }
        // Join suggestions are a bonus; completion works without them
        if let Ok(keys) = self
            .rows(
                "SELECT table_name, constraint_name, column_name, referenced_table_schema, \
                 referenced_table_name, referenced_column_name \
                 FROM information_schema.key_column_usage \
                 WHERE table_schema = ? AND referenced_table_name IS NOT NULL \
                 ORDER BY table_name, constraint_name, ordinal_position LIMIT 20000",
                vec![database.into()],
            )
            .await
        {
            attach_keys(
                &mut tables,
                keys.iter()
                    .map(|r| {
                        let ref_schema = text(r, 3).filter(|s| s != database);
                        KeyColumn {
                            schema: None,
                            table: text(r, 0).unwrap_or_default(),
                            key: text(r, 1).unwrap_or_default(),
                            column: text(r, 2).unwrap_or_default(),
                            ref_schema,
                            ref_table: text(r, 4).unwrap_or_default(),
                            ref_column: text(r, 5).unwrap_or_default(),
                        }
                    })
                    .collect(),
            );
        }
        Ok(tables)
    }
}
