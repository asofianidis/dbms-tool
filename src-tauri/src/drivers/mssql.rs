//! SQL Server and Babelfish for Aurora PostgreSQL over TDS (tiberius).
//!
//! Babelfish implements most of the SQL Server catalog, but not all of it, so
//! metadata queries prefer `sys.*` views and fall back to `INFORMATION_SCHEMA`.

use std::time::Duration;

use futures_util::TryStreamExt;
use serde_json::Value;
use tiberius::{
    AuthMethod, Client, ColumnData, ColumnType, Config, EncryptionLevel, FromSql, QueryItem, Row,
    SqlBrowser, ToSql,
};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use crate::config::{AuthMode, ConnectionConfig, Engine, SslMode};
use crate::error::{AppError, AppResult};
use crate::model::*;

pub struct MsSession {
    client: Client<Compat<TcpStream>>,
    pub database: String,
    pub babelfish: bool,
    /// Set when a cancel couldn't resynchronise the stream; the manager reconnects
    pub broken: bool,
}

pub fn describe_error(e: &tiberius::error::Error) -> String {
    match e {
        tiberius::error::Error::Server(t) => format!(
            "Msg {}, Level {}, State {}, Line {}\n{}",
            t.code(),
            t.class(),
            t.state(),
            t.line(),
            t.message()
        ),
        tiberius::error::Error::Tls(m) => format!(
            "TLS error: {m}. If the server uses a self-signed certificate, enable \"Trust server certificate\"."
        ),
        other => other.to_string(),
    }
}

fn quote_ident(name: &str) -> String {
    format!("[{}]", name.replace(']', "]]"))
}

fn build_config(
    cfg: &ConnectionConfig,
    password: Option<&str>,
    database: &str,
) -> AppResult<Config> {
    let mut config = Config::new();
    // `host\INSTANCE` resolves the port through the SQL Server Browser service
    let (host, instance) = match cfg.host.split_once('\\') {
        Some((h, i)) => (h, Some(i)),
        None => (cfg.host.as_str(), None),
    };
    config.host(if host.is_empty() { "localhost" } else { host });
    match instance {
        Some(name) if cfg.port == 0 => config.instance_name(name),
        _ => config.port(if cfg.port == 0 { 1433 } else { cfg.port }),
    }
    if !database.is_empty() {
        config.database(database);
    }
    config.application_name("dbms-tool");
    match cfg.auth {
        AuthMode::Password => {
            config.authentication(AuthMethod::sql_server(&cfg.user, password.unwrap_or("")))
        }
        #[cfg(windows)]
        AuthMode::Windows => {
            if cfg.user.is_empty() {
                config.authentication(AuthMethod::Integrated)
            } else {
                config.authentication(AuthMethod::windows(&cfg.user, password.unwrap_or("")))
            }
        }
        #[cfg(not(windows))]
        AuthMode::Windows => {
            return Err(AppError::Unsupported(
                "Windows authentication is only available on Windows".into(),
            ));
        }
        AuthMode::Cloud => config.authentication(AuthMethod::aad_token(password.unwrap_or(""))),
    }
    config.encryption(match cfg.ssl {
        SslMode::Disable => EncryptionLevel::NotSupported,
        SslMode::Prefer => EncryptionLevel::Off,
        SslMode::Require => EncryptionLevel::Required,
    });
    if cfg.trust_server_certificate {
        config.trust_cert();
    }
    Ok(config)
}

async fn open(mut config: Config) -> AppResult<Client<Compat<TcpStream>>> {
    // Azure SQL may redirect the login to another node; follow it once
    for _ in 0..2 {
        let tcp = tokio::time::timeout(Duration::from_secs(15), TcpStream::connect_named(&config))
            .await
            .map_err(|_| AppError::msg("Timed out connecting to the server"))??;
        tcp.set_nodelay(true)?;
        match Client::connect(config.clone(), tcp.compat_write()).await {
            Ok(client) => return Ok(client),
            Err(tiberius::error::Error::Routing { host, port }) => {
                config.host(&host);
                config.port(port);
            }
            Err(e) => return Err(e.into()),
        }
    }
    Err(AppError::msg("Too many redirects while connecting"))
}

pub async fn connect(
    cfg: &ConnectionConfig,
    password: Option<&str>,
    database: &str,
) -> AppResult<MsSession> {
    let config = build_config(cfg, password, database)?;
    let client = open(config).await?;
    let mut session = MsSession {
        client,
        database: database.to_string(),
        babelfish: cfg.engine == Engine::Babelfish,
        broken: false,
    };
    if let Ok(rows) = session.rows("SELECT DB_NAME()", &[]).await
        && let Some(db) = rows.first().and_then(|r| text(r, 0))
    {
        session.database = db;
    }
    if let Ok(rows) = session
        .rows(
            "SELECT CAST(SERVERPROPERTY('BabelfishVersion') AS nvarchar(128))",
            &[],
        )
        .await
        && rows.first().and_then(|r| text(r, 0)).is_some()
    {
        session.babelfish = true;
    }
    Ok(session)
}

/// T-SQL name for a TDS column type.
fn type_name(ty: ColumnType) -> &'static str {
    match ty {
        ColumnType::Null => "",
        ColumnType::Bit | ColumnType::Bitn => "bit",
        ColumnType::Int1 => "tinyint",
        ColumnType::Int2 => "smallint",
        ColumnType::Int4 => "int",
        ColumnType::Int8 => "bigint",
        ColumnType::Intn => "int",
        ColumnType::Datetime4 => "smalldatetime",
        ColumnType::Datetime | ColumnType::Datetimen => "datetime",
        ColumnType::Float4 => "real",
        ColumnType::Float8 | ColumnType::Floatn => "float",
        ColumnType::Money | ColumnType::Money4 => "money",
        ColumnType::Guid => "uniqueidentifier",
        ColumnType::Decimaln => "decimal",
        ColumnType::Numericn => "numeric",
        ColumnType::Daten => "date",
        ColumnType::Timen => "time",
        ColumnType::Datetime2 => "datetime2",
        ColumnType::DatetimeOffsetn => "datetimeoffset",
        ColumnType::BigVarBin => "varbinary",
        ColumnType::BigBinary => "binary",
        ColumnType::BigVarChar => "varchar",
        ColumnType::BigChar => "char",
        ColumnType::NVarchar => "nvarchar",
        ColumnType::NChar => "nchar",
        ColumnType::Xml => "xml",
        ColumnType::Udt => "udt",
        ColumnType::Text => "text",
        ColumnType::Image => "image",
        ColumnType::NText => "ntext",
        ColumnType::SSVariant => "sql_variant",
    }
}

fn cell(data: &ColumnData<'static>) -> Value {
    let s = |v: String| Value::String(v);
    match data {
        ColumnData::U8(v) => v.map_or(Value::Null, |n| s(n.to_string())),
        ColumnData::I16(v) => v.map_or(Value::Null, |n| s(n.to_string())),
        ColumnData::I32(v) => v.map_or(Value::Null, |n| s(n.to_string())),
        ColumnData::I64(v) => v.map_or(Value::Null, |n| s(n.to_string())),
        ColumnData::F32(v) => v.map_or(Value::Null, |n| s(n.to_string())),
        ColumnData::F64(v) => v.map_or(Value::Null, |n| s(n.to_string())),
        ColumnData::Bit(v) => v.map_or(Value::Null, |b| s(if b { "1" } else { "0" }.into())),
        ColumnData::String(v) => v.as_ref().map_or(Value::Null, |t| s(t.to_string())),
        ColumnData::Guid(v) => v.map_or(Value::Null, |g| s(g.to_string().to_uppercase())),
        ColumnData::Binary(v) => v.as_ref().map_or(Value::Null, |b| s(hex_bytes(b))),
        ColumnData::Numeric(v) => v.map_or(Value::Null, |n| s(n.to_string())),
        ColumnData::Xml(v) => v.as_ref().map_or(Value::Null, |x| s(x.to_string())),
        ColumnData::DateTime(_) | ColumnData::SmallDateTime(_) | ColumnData::DateTime2(_) => {
            match chrono::NaiveDateTime::from_sql(data) {
                Ok(Some(dt)) => s(dt.format("%Y-%m-%d %H:%M:%S%.3f").to_string()),
                _ => Value::Null,
            }
        }
        ColumnData::Date(_) => match chrono::NaiveDate::from_sql(data) {
            Ok(Some(d)) => s(d.format("%Y-%m-%d").to_string()),
            _ => Value::Null,
        },
        ColumnData::Time(_) => match chrono::NaiveTime::from_sql(data) {
            Ok(Some(t)) => s(t.format("%H:%M:%S%.f").to_string()),
            _ => Value::Null,
        },
        ColumnData::DateTimeOffset(_) => {
            match chrono::DateTime::<chrono::FixedOffset>::from_sql(data) {
                Ok(Some(dt)) => s(dt.format("%Y-%m-%d %H:%M:%S%.f %:z").to_string()),
                _ => Value::Null,
            }
        }
    }
}

fn text(row: &Row, i: usize) -> Option<String> {
    let (_, data) = row.cells().nth(i)?;
    match cell(data) {
        Value::String(s) => Some(s),
        _ => None,
    }
}

fn flag(row: &Row, i: usize) -> bool {
    matches!(text(row, i).as_deref(), Some("1") | Some("true"))
}

/// Splits a script on `GO` lines, as SSMS and sqlcmd do. Returns
/// `(first line number, batch, repeat count)`.
pub fn split_batches(script: &str) -> Vec<(u32, String, u32)> {
    let mut batches = Vec::new();
    let mut current = String::new();
    let mut start = 1u32;
    let mut in_block_comment = false;
    for (i, line) in script.split_inclusive('\n').enumerate() {
        let line_no = i as u32 + 1;
        // `GO -- comment` is still a separator
        let trimmed = line.split("--").next().unwrap_or("").trim();
        // Track /* */ so a GO inside a block comment isn't treated as a separator
        let was_in_comment = in_block_comment;
        let mut rest = line;
        loop {
            if in_block_comment {
                match rest.find("*/") {
                    Some(p) => {
                        in_block_comment = false;
                        rest = &rest[p + 2..];
                    }
                    None => break,
                }
            } else {
                match rest.find("/*") {
                    Some(p) => {
                        in_block_comment = true;
                        rest = &rest[p + 2..];
                    }
                    None => break,
                }
            }
        }
        let mut words = trimmed.split_whitespace();
        let is_go =
            !was_in_comment && words.next().is_some_and(|w| w.eq_ignore_ascii_case("go")) && {
                let count = words.next();
                words.next().is_none() && count.is_none_or(|c| c.parse::<u32>().is_ok())
            };
        if is_go {
            let repeat = trimmed
                .split_whitespace()
                .nth(1)
                .and_then(|c| c.parse().ok())
                .unwrap_or(1);
            if !current.trim().is_empty() {
                batches.push((start, std::mem::take(&mut current), repeat));
            } else {
                current.clear();
            }
            start = line_no + 1;
        } else {
            current.push_str(line);
        }
    }
    if !current.trim().is_empty() {
        batches.push((start, current, 1));
    }
    batches
}

impl MsSession {
    async fn rows(&mut self, sql: &str, params: &[&dyn ToSql]) -> AppResult<Vec<Row>> {
        let stream = self.client.query(sql, params).await?;
        Ok(stream.into_first_result().await?)
    }

    pub async fn ping(&mut self) -> bool {
        self.rows("SELECT 1", &[]).await.is_ok()
    }

    pub async fn use_database(&mut self, database: &str) -> AppResult<()> {
        if database.is_empty() || database.eq_ignore_ascii_case(&self.database) {
            return Ok(());
        }
        let sql = format!("USE {}", quote_ident(database));
        self.client
            .simple_query_all(sql)
            .await?
            .into_results()
            .await?;
        self.database = database.to_string();
        Ok(())
    }

    pub async fn server_info(&mut self) -> AppResult<ServerInfo> {
        let rows = self
            .rows(
                "SELECT @@VERSION, DB_NAME(), SUSER_SNAME(), \
                   CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)), \
                   CAST(SERVERPROPERTY('BabelfishVersion') AS nvarchar(128))",
                &[],
            )
            .await?;
        let row = rows
            .first()
            .ok_or_else(|| AppError::msg("Server returned no version"))?;
        let version = text(row, 0).unwrap_or_default();
        let babelfish_version = text(row, 4);
        let product = match &babelfish_version {
            Some(v) => format!("Babelfish {v}"),
            None => {
                // "Microsoft SQL Server 2022 (RTM) …" → "SQL Server 2022"
                let banner = version.lines().next().unwrap_or("");
                let name = banner
                    .trim_start_matches("Microsoft ")
                    .split(" (")
                    .next()
                    .unwrap_or("SQL Server")
                    .split(" - ")
                    .next()
                    .unwrap_or("SQL Server");
                name.to_string()
            }
        };
        Ok(ServerInfo {
            product,
            version,
            current_database: text(row, 1).unwrap_or_default(),
            user: text(row, 2).unwrap_or_default(),
            babelfish_version,
        })
    }

    pub async fn execute(
        &mut self,
        sql: &str,
        opts: &ExecOptions,
        cancel: &CancelSignal,
    ) -> ExecOutput {
        let mut out = OutputBuilder::new(opts);
        'batches: for (start_line, batch, repeat) in split_batches(sql) {
            for _ in 0..repeat {
                if out.cancelled {
                    break 'batches;
                }
                if let Err(e) = self.run_batch(&batch, start_line, &mut out, cancel).await {
                    // Errors already reported as messages arrive here a second time
                    if out.error.is_none() && !out.cancelled {
                        out.fail(describe_error(&e), None, None);
                    }
                    if self.broken || !self.ping().await {
                        self.broken = true;
                        out.message(
                            "warning",
                            "The connection was reset; it will be reopened on the next run.",
                        );
                        break 'batches;
                    }
                }
            }
        }
        out.finish(Some(self.database.clone()))
    }

    async fn run_batch(
        &mut self,
        batch: &str,
        start_line: u32,
        out: &mut OutputBuilder,
        cancel: &CancelSignal,
    ) -> Result<(), tiberius::error::Error> {
        let mut database = None;
        let cancelled = {
            let mut stream = self.client.simple_query_all(batch).await?;
            let mut cancelled = false;
            loop {
                let item = tokio::select! {
                    biased;
                    _ = cancel.wait() => { cancelled = true; break; }
                    item = stream.try_next() => item?,
                };
                let Some(item) = item else { break };
                match item {
                    QueryItem::Metadata(meta) => out.begin_set(
                        meta.columns()
                            .iter()
                            .map(|c| ColumnMeta {
                                name: c.name().to_string(),
                                type_name: type_name(c.column_type()).to_string(),
                            })
                            .collect(),
                    ),
                    QueryItem::Row(row) => {
                        if out.wants_rows() {
                            out.push_row(row.cells().map(|(_, data)| cell(data)).collect());
                        } else {
                            out.skip_row();
                        }
                    }
                    QueryItem::Done(rows) => {
                        if out.has_open_set() {
                            out.end_set(rows);
                        } else if let Some(n) = rows {
                            out.affected(n);
                        }
                    }
                    QueryItem::Message(m) => {
                        if m.is_error {
                            let line = (m.line > 0).then(|| start_line + m.line - 1);
                            let text = format!(
                                "Msg {}, Level {}, Line {}\n{}",
                                m.number,
                                m.class,
                                line.unwrap_or(m.line),
                                m.message
                            );
                            out.fail(text, None, line);
                        } else {
                            out.message("info", m.message);
                        }
                    }
                    QueryItem::DatabaseChanged(db) => database = Some(db),
                }
            }
            cancelled
        };
        if let Some(db) = database {
            self.database = db;
        }
        if cancelled {
            out.cancelled = true;
            if self.broken {
                out.message("warning", "The connection was reset after cancelling; it will be reopened on the next run.");
            }
            let acknowledged =
                tokio::time::timeout(Duration::from_secs(10), self.client.cancel_query()).await;
            if !matches!(acknowledged, Ok(Ok(()))) {
                self.broken = true;
            }
        }
        Ok(())
    }

    /// Runs `sql` in `database`; on failure (Babelfish gaps) runs `fallback` instead.
    async fn rows_in(
        &mut self,
        database: &str,
        sql: &str,
        fallback: Option<&str>,
        params: &[&dyn ToSql],
    ) -> AppResult<Vec<Row>> {
        self.use_database(database).await?;
        match self.rows(sql, params).await {
            Ok(rows) => Ok(rows),
            Err(e) => match fallback {
                Some(f) => self.rows(f, params).await,
                None => Err(e),
            },
        }
    }

    pub async fn list_databases(&mut self) -> AppResult<Vec<DatabaseInfo>> {
        let rows = self
            .rows("SELECT name FROM sys.databases ORDER BY name", &[])
            .await?;
        Ok(rows
            .iter()
            .map(|r| {
                let name = text(r, 0).unwrap_or_default();
                DatabaseInfo {
                    is_system: matches!(
                        name.to_lowercase().as_str(),
                        "master" | "tempdb" | "model" | "msdb"
                    ),
                    name,
                    size_bytes: None,
                }
            })
            .collect())
    }

    pub async fn list_schemas(&mut self, database: &str) -> AppResult<Vec<SchemaInfo>> {
        const SYSTEM: &[&str] = &[
            "sys",
            "information_schema",
            "guest",
            "db_owner",
            "db_accessadmin",
            "db_securityadmin",
            "db_ddladmin",
            "db_backupoperator",
            "db_datareader",
            "db_datawriter",
            "db_denydatareader",
            "db_denydatawriter",
        ];
        let rows = self
            .rows_in(
                database,
                "SELECT name FROM sys.schemas ORDER BY name",
                Some("SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA ORDER BY SCHEMA_NAME"),
                &[],
            )
            .await?;
        Ok(rows
            .iter()
            .map(|r| {
                let name = text(r, 0).unwrap_or_default();
                SchemaInfo {
                    is_system: SYSTEM.contains(&name.to_lowercase().as_str()),
                    name,
                }
            })
            .collect())
    }

    pub async fn list_objects(&mut self, database: &str) -> AppResult<Vec<DbObject>> {
        let rows = self
            .rows_in(
                database,
                "SELECT s.name, o.name, \
                   CASE o.type WHEN 'U' THEN 'table' WHEN 'V' THEN 'view' WHEN 'P' THEN 'procedure' \
                     WHEN 'SN' THEN 'synonym' ELSE 'function' END \
                 FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id \
                 WHERE o.type IN ('U', 'V', 'P', 'FN', 'IF', 'TF', 'SN') AND o.is_ms_shipped = 0 \
                 ORDER BY s.name, o.name",
                Some(
                    "SELECT TABLE_SCHEMA, TABLE_NAME, \
                       CASE TABLE_TYPE WHEN 'VIEW' THEN 'view' ELSE 'table' END \
                     FROM INFORMATION_SCHEMA.TABLES \
                     UNION ALL \
                     SELECT ROUTINE_SCHEMA, ROUTINE_NAME, \
                       CASE ROUTINE_TYPE WHEN 'PROCEDURE' THEN 'procedure' ELSE 'function' END \
                     FROM INFORMATION_SCHEMA.ROUTINES \
                     ORDER BY 1, 2",
                ),
                &[],
            )
            .await?;
        let mut objects: Vec<DbObject> = rows
            .iter()
            .map(|r| DbObject {
                schema: text(r, 0),
                name: text(r, 1).unwrap_or_default(),
                kind: text(r, 2).unwrap_or_default(),
                detail: None,
                comment: None,
                row_estimate: None,
            })
            .collect();
        // Row counts are a nicety; Babelfish may not expose partition stats
        if let Ok(counts) = self
            .rows(
                "SELECT SCHEMA_NAME(t.schema_id), t.name, SUM(p.rows) \
                 FROM sys.tables t JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1) \
                 GROUP BY t.schema_id, t.name",
                &[],
            )
            .await
        {
            for r in &counts {
                let (schema, name) = (text(r, 0), text(r, 1));
                if let Some(obj) = objects
                    .iter_mut()
                    .find(|o| o.kind == "table" && o.schema == schema && Some(&o.name) == name.as_ref())
                {
                    obj.row_estimate = text(r, 2).and_then(|n| n.parse().ok());
                }
            }
        }
        Ok(objects)
    }

    pub async fn describe_table(
        &mut self,
        database: &str,
        schema: &str,
        table: &str,
    ) -> AppResult<TableInfo> {
        let qualified = format!("{}.{}", quote_ident(schema), quote_ident(table));
        let columns = self
            .rows_in(
                database,
                "SELECT c.COLUMN_NAME, \
                   c.DATA_TYPE + CASE \
                     WHEN c.CHARACTER_MAXIMUM_LENGTH = -1 THEN '(max)' \
                     WHEN c.CHARACTER_MAXIMUM_LENGTH IS NOT NULL THEN '(' + CAST(c.CHARACTER_MAXIMUM_LENGTH AS varchar(10)) + ')' \
                     WHEN c.DATA_TYPE IN ('decimal', 'numeric') THEN '(' + CAST(c.NUMERIC_PRECISION AS varchar(10)) + ',' + CAST(c.NUMERIC_SCALE AS varchar(10)) + ')' \
                     ELSE '' END, \
                   CASE c.IS_NULLABLE WHEN 'YES' THEN 1 ELSE 0 END, c.COLUMN_DEFAULT, \
                   CAST(ISNULL(sc.is_identity, 0) | ISNULL(sc.is_computed, 0) AS int), \
                   CAST(ISNULL(sc.is_identity, 0) AS int) \
                 FROM INFORMATION_SCHEMA.COLUMNS c \
                 LEFT JOIN sys.columns sc ON sc.object_id = OBJECT_ID(@P1) AND sc.name = c.COLUMN_NAME \
                 WHERE c.TABLE_SCHEMA = @P2 AND c.TABLE_NAME = @P3 \
                 ORDER BY c.ORDINAL_POSITION",
                Some(
                    "SELECT c.COLUMN_NAME, c.DATA_TYPE, CASE c.IS_NULLABLE WHEN 'YES' THEN 1 ELSE 0 END, \
                       c.COLUMN_DEFAULT, 0, 0, @P1 \
                     FROM INFORMATION_SCHEMA.COLUMNS c \
                     WHERE c.TABLE_SCHEMA = @P2 AND c.TABLE_NAME = @P3 ORDER BY c.ORDINAL_POSITION",
                ),
                &[&qualified.as_str(), &schema, &table],
            )
            .await?;
        let index_rows = self
            .rows(
                "SELECT i.name, CAST(i.is_unique AS int), CAST(i.is_primary_key AS int), i.type_desc, c.name \
                 FROM sys.indexes i \
                 JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
                 JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
                 WHERE i.object_id = OBJECT_ID(@P1) AND ic.is_included_column = 0 AND i.name IS NOT NULL \
                 ORDER BY i.is_primary_key DESC, i.name, ic.key_ordinal",
                &[&qualified.as_str()],
            )
            .await;
        let index_rows = match index_rows {
            Ok(rows) => rows,
            // Fallback: constraints only (primary keys and unique constraints)
            Err(_) => self
                .rows(
                    "SELECT tc.CONSTRAINT_NAME, 1, CASE tc.CONSTRAINT_TYPE WHEN 'PRIMARY KEY' THEN 1 ELSE 0 END, \
                       tc.CONSTRAINT_TYPE, k.COLUMN_NAME \
                     FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc \
                     JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE k \
                       ON k.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND k.CONSTRAINT_NAME = tc.CONSTRAINT_NAME \
                     WHERE tc.TABLE_SCHEMA = @P1 AND tc.TABLE_NAME = @P2 \
                       AND tc.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE') \
                     ORDER BY 3 DESC, 1, k.ORDINAL_POSITION",
                    &[&schema, &table],
                )
                .await
                .unwrap_or_default(),
        };
        let fk_rows = self
            .rows(
                "SELECT rc.CONSTRAINT_NAME, k.COLUMN_NAME, k2.TABLE_SCHEMA, k2.TABLE_NAME, k2.COLUMN_NAME, \
                   rc.UPDATE_RULE, rc.DELETE_RULE \
                 FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc \
                 JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE k \
                   ON k.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA AND k.CONSTRAINT_NAME = rc.CONSTRAINT_NAME \
                 JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE k2 \
                   ON k2.CONSTRAINT_SCHEMA = rc.UNIQUE_CONSTRAINT_SCHEMA \
                  AND k2.CONSTRAINT_NAME = rc.UNIQUE_CONSTRAINT_NAME \
                  AND k2.ORDINAL_POSITION = k.ORDINAL_POSITION \
                 WHERE k.TABLE_SCHEMA = @P1 AND k.TABLE_NAME = @P2 \
                 ORDER BY rc.CONSTRAINT_NAME, k.ORDINAL_POSITION",
                &[&schema, &table],
            )
            .await
            .unwrap_or_default();
        let trigger_rows = self
            .rows(
                "SELECT tr.name, CASE tr.is_instead_of_trigger WHEN 1 THEN 'INSTEAD OF' ELSE 'AFTER' END, \
                   te.type_desc, CAST(tr.is_disabled AS int), OBJECT_DEFINITION(tr.object_id) \
                 FROM sys.triggers tr \
                 JOIN sys.trigger_events te ON te.object_id = tr.object_id \
                 WHERE tr.parent_id = OBJECT_ID(@P1) \
                 ORDER BY tr.name, te.type",
                &[&qualified.as_str()],
            )
            .await
            .unwrap_or_default();

        let mut indexes: Vec<IndexInfo> = Vec::new();
        for r in &index_rows {
            let name = text(r, 0).unwrap_or_default();
            let column = text(r, 4).unwrap_or_default();
            match indexes.iter_mut().find(|i| i.name == name) {
                Some(index) => index.columns.push(column),
                None => indexes.push(IndexInfo {
                    unique: flag(r, 1),
                    primary: flag(r, 2),
                    method: text(r, 3).map(|m| m.to_lowercase()),
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
        for r in &fk_rows {
            let name = text(r, 0).unwrap_or_default();
            let (column, ref_column) = (
                text(r, 1).unwrap_or_default(),
                text(r, 4).unwrap_or_default(),
            );
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

        let mut triggers: Vec<TriggerInfo> = Vec::new();
        for r in &trigger_rows {
            let name = text(r, 0).unwrap_or_default();
            let event = text(r, 2).unwrap_or_default();
            match triggers.iter_mut().find(|t| t.name == name) {
                Some(trigger) => trigger.events.push(event),
                None => triggers.push(TriggerInfo {
                    name,
                    timing: text(r, 1).unwrap_or_default(),
                    events: vec![event],
                    // T-SQL triggers fire once per statement
                    row_level: false,
                    enabled: !flag(r, 3),
                    definition: text(r, 4),
                }),
            }
        }

        Ok(TableInfo {
            columns: columns
                .iter()
                .map(|r| {
                    let name = text(r, 0).unwrap_or_default();
                    ColumnInfo {
                        is_primary_key: primary_key.contains(&name),
                        name,
                        data_type: text(r, 1).unwrap_or_default(),
                        nullable: flag(r, 2),
                        default: text(r, 3),
                        is_generated: flag(r, 4),
                        is_identity: flag(r, 5),
                        comment: None,
                        extra: None,
                    }
                })
                .collect(),
            primary_key,
            indexes,
            foreign_keys,
            triggers,
        })
    }

    pub async fn object_definition(
        &mut self,
        database: &str,
        schema: &str,
        name: &str,
    ) -> AppResult<Option<String>> {
        let qualified = format!("{}.{}", quote_ident(schema), quote_ident(name));
        let rows = self
            .rows_in(
                database,
                "SELECT m.definition FROM sys.sql_modules m WHERE m.object_id = OBJECT_ID(@P1)",
                Some(
                    "SELECT VIEW_DEFINITION FROM INFORMATION_SCHEMA.VIEWS \
                     WHERE QUOTENAME(TABLE_SCHEMA) + '.' + QUOTENAME(TABLE_NAME) = @P1 \
                     UNION ALL \
                     SELECT ROUTINE_DEFINITION FROM INFORMATION_SCHEMA.ROUTINES \
                     WHERE QUOTENAME(ROUTINE_SCHEMA) + '.' + QUOTENAME(ROUTINE_NAME) = @P1",
                ),
                &[&qualified.as_str()],
            )
            .await?;
        Ok(rows.first().and_then(|r| text(r, 0)))
    }

    pub async fn describe_routine(
        &mut self,
        database: &str,
        schema: &str,
        name: &str,
        kind: &str,
    ) -> AppResult<RoutineInfo> {
        let qualified = format!("{}.{}", quote_ident(schema), quote_ident(name));
        let rows = self
            .rows_in(
                database,
                "SELECT p.name, \
                   TYPE_NAME(p.user_type_id) + CASE \
                     WHEN TYPE_NAME(p.user_type_id) IN ('varchar', 'char', 'varbinary', 'binary') \
                       THEN '(' + CASE WHEN p.max_length = -1 THEN 'max' ELSE CAST(p.max_length AS varchar(10)) END + ')' \
                     WHEN TYPE_NAME(p.user_type_id) IN ('nvarchar', 'nchar') \
                       THEN '(' + CASE WHEN p.max_length = -1 THEN 'max' ELSE CAST(p.max_length / 2 AS varchar(10)) END + ')' \
                     WHEN TYPE_NAME(p.user_type_id) IN ('decimal', 'numeric') \
                       THEN '(' + CAST(p.precision AS varchar(10)) + ',' + CAST(p.scale AS varchar(10)) + ')' \
                     ELSE '' END, \
                   CAST(p.is_output AS int), p.parameter_id \
                 FROM sys.all_parameters p WHERE p.object_id = OBJECT_ID(@P1) ORDER BY p.parameter_id",
                Some(
                    "SELECT PARAMETER_NAME, DATA_TYPE + CASE \
                       WHEN CHARACTER_MAXIMUM_LENGTH = -1 THEN '(max)' \
                       WHEN CHARACTER_MAXIMUM_LENGTH IS NOT NULL THEN '(' + CAST(CHARACTER_MAXIMUM_LENGTH AS varchar(10)) + ')' \
                       ELSE '' END, \
                       CASE PARAMETER_MODE WHEN 'IN' THEN 0 ELSE 1 END, \
                       CASE IS_RESULT WHEN 'YES' THEN 0 ELSE ORDINAL_POSITION END \
                     FROM INFORMATION_SCHEMA.PARAMETERS \
                     WHERE QUOTENAME(SPECIFIC_SCHEMA) + '.' + QUOTENAME(SPECIFIC_NAME) = @P1 \
                     ORDER BY ORDINAL_POSITION",
                ),
                &[&qualified.as_str()],
            )
            .await?;
        let mut info = RoutineInfo {
            language: Some("T-SQL".into()),
            ..Default::default()
        };
        for r in &rows {
            let name = text(r, 0).unwrap_or_default();
            // Parameter 0 is a scalar function's return value
            if text(r, 3).as_deref() == Some("0") || name.is_empty() {
                info.returns.get_or_insert(text(r, 1).unwrap_or_default());
                continue;
            }
            info.params.push(RoutineParam {
                name,
                data_type: text(r, 1).unwrap_or_default(),
                mode: if flag(r, 2) { "OUTPUT" } else { "IN" }.into(),
            });
        }
        // Scalar functions have a return-value row; table-valued ones don't. (Babelfish
        // reports TVFs as type FN, so sys.objects can't tell them apart.)
        if kind == "function" && info.returns.is_none() {
            info.returns = Some("TABLE".into());
        }
        Ok(info)
    }

    pub async fn completion(&mut self, database: &str) -> AppResult<Vec<CompletionTable>> {
        let rows = self
            .rows_in(
                database,
                "SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS \
                 ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION",
                None,
                &[],
            )
            .await?;
        let mut tables: Vec<CompletionTable> = Vec::new();
        for r in rows.iter().take(50_000) {
            let (schema, table, column) = (
                text(r, 0),
                text(r, 1).unwrap_or_default(),
                text(r, 2).unwrap_or_default(),
            );
            match tables.last_mut() {
                Some(t) if t.name == table && t.schema == schema => t.columns.push(column),
                _ => tables.push(CompletionTable {
                    schema,
                    name: table,
                    columns: vec![column],
                }),
            }
        }
        Ok(tables)
    }
}

#[cfg(test)]
mod tests {
    use super::split_batches;

    #[test]
    fn splits_on_go_lines() {
        let batches = split_batches("SELECT 1\nGO\nSELECT 2\ngo 3\n  GO  \nSELECT 3");
        assert_eq!(batches.len(), 3);
        assert_eq!(batches[0], (1, "SELECT 1\n".into(), 1));
        assert_eq!(batches[1], (3, "SELECT 2\n".into(), 3));
        assert_eq!(batches[2], (6, "SELECT 3".into(), 1));
    }

    #[test]
    fn ignores_go_in_identifiers_and_comments() {
        let batches = split_batches("SELECT goal FROM t\n/*\nGO\n*/\nSELECT 1");
        assert_eq!(batches.len(), 1);
        let batches = split_batches("SELECT 1\nGO -- end of batch\nSELECT 2");
        assert_eq!(batches.len(), 2);
    }
}
