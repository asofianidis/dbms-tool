//! PostgreSQL via tokio-postgres. Queries run over the simple-query protocol so
//! every value arrives as text, exactly as psql would print it.

use std::collections::VecDeque;
use std::error::Error as _;
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use parking_lot::Mutex;
use postgres_native_tls::MakeTlsConnector;
use serde::Serialize;
use serde_json::Value;
use tokio::task::JoinHandle;
use tokio_postgres::config::SslMode as PgSslMode;
use tokio_postgres::error::ErrorPosition;
use tokio_postgres::{AsyncMessage, Client, SimpleQueryMessage};

use crate::config::{ConnectionConfig, SslMode};
use crate::error::{AppError, AppResult};
use crate::model::*;

mod table_ddl;

pub struct PgSession {
    client: Client,
    tls: MakeTlsConnector,
    notices: Arc<Mutex<Vec<(String, String)>>>,
    inbox: Arc<Mutex<Inbox>>,
    pub database: String,
    task: JoinHandle<()>,
}

impl Drop for PgSession {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Most notifications a session holds until they're read; older ones give way.
const INBOX_CAPACITY: usize = 1000;

/// Most notifications listed in a statement's messages; the rest are counted.
const NOTIFICATIONS_SHOWN: usize = 100;

/// A `NOTIFY` delivered to a channel the session listens on.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgNotification {
    pub channel: String,
    pub payload: String,
    /// The sending backend's process id
    pub pid: i32,
    /// Unix time in milliseconds
    pub at: i64,
}

/// Notifications the connection has received and nobody has read yet.
#[derive(Debug, Default)]
pub struct Inbox {
    pub items: VecDeque<PgNotification>,
    /// Pushed out by newer ones while the inbox was full
    pub dropped: u64,
    /// Why the connection ended, once it has
    pub closed: Option<String>,
}

impl Inbox {
    fn push(&mut self, n: PgNotification) {
        if self.items.len() >= INBOX_CAPACITY {
            self.items.pop_front();
            self.dropped += 1;
        }
        self.items.push_back(n);
    }

    /// Everything waiting, and how many were dropped since the last take.
    pub fn take(&mut self) -> (Vec<PgNotification>, u64) {
        (
            self.items.drain(..).collect(),
            std::mem::take(&mut self.dropped),
        )
    }
}

/// How a notification reads in the query messages, like psql's
/// `Asynchronous notification "chan" with payload "x" received from server process with PID 123.`
pub fn notification_line(n: &PgNotification) -> String {
    if n.payload.is_empty() {
        format!("NOTIFY {} (pid {})", n.channel, n.pid)
    } else {
        format!("NOTIFY {} (pid {}): {}", n.channel, n.pid, n.payload)
    }
}

pub fn describe_error(e: &tokio_postgres::Error) -> String {
    if let Some(db) = e.as_db_error() {
        let mut s = format!("{}: {}", db.severity(), db.message());
        if let Some(detail) = db.detail() {
            s.push_str(&format!("\nDETAIL: {detail}"));
        }
        if let Some(hint) = db.hint() {
            s.push_str(&format!("\nHINT: {hint}"));
        }
        if let Some(context) = db.where_() {
            s.push_str(&format!("\nCONTEXT: {context}"));
        }
        return s;
    }
    let mut s = e.to_string();
    let mut source = e.source();
    while let Some(inner) = source {
        let text = inner.to_string();
        if !s.contains(&text) {
            s.push_str(": ");
            s.push_str(&text);
        }
        source = inner.source();
    }
    s
}

fn error_position(e: &tokio_postgres::Error) -> Option<u32> {
    match e.as_db_error()?.position()? {
        ErrorPosition::Original(p) => Some(*p),
        ErrorPosition::Internal { .. } => None,
    }
}

pub async fn connect(
    cfg: &ConnectionConfig,
    password: Option<&str>,
    database: &str,
) -> AppResult<PgSession> {
    let mut pg = tokio_postgres::Config::new();
    match (&cfg.tunneled, cfg.host.parse::<std::net::IpAddr>()) {
        // Connect to the tunnel, but check the certificate against the real server
        (Some((origin, _)), Ok(local)) => pg.host(origin).hostaddr(local),
        _ => pg.host(&cfg.host),
    };
    pg.port(if cfg.port == 0 { 5432 } else { cfg.port })
        .user(&cfg.user)
        .dbname(if database.is_empty() {
            "postgres"
        } else {
            database
        })
        .application_name("dbms-tool")
        .connect_timeout(crate::limits::connect_timeout())
        .ssl_mode(match cfg.ssl {
            SslMode::Disable => PgSslMode::Disable,
            SslMode::Prefer => PgSslMode::Prefer,
            // Certificate checks are the TLS connector's job
            SslMode::Require | SslMode::VerifyCa | SslMode::VerifyFull => PgSslMode::Require,
        });
    if let Some(p) = password {
        pg.password(p);
    }

    // Like libpq, Prefer never verifies; Require does unless the user opted out.
    // Through a tunnel the name checked is the real server's (`pg.host` above).
    let connector = super::tls::native_connector(cfg)?;
    let tls = MakeTlsConnector::new(connector);

    // connect_timeout only bounds the TCP connect; a server that accepts and then stalls
    // during startup would otherwise hang forever
    let (client, mut connection) = tokio::time::timeout(
        crate::limits::connect_timeout() + Duration::from_secs(5),
        pg.connect(tls.clone()),
    )
    .await
    .map_err(|_| {
        AppError::msg("Timed out waiting for the server to finish the connection handshake")
    })??;
    let notices = Arc::new(Mutex::new(Vec::new()));
    let inbox = Arc::new(Mutex::new(Inbox::default()));
    let (sink, mailbox) = (notices.clone(), inbox.clone());
    let task = tokio::spawn(async move {
        let mut messages = futures_util::stream::poll_fn(move |cx| connection.poll_message(cx));
        let mut ended = None;
        while let Some(message) = messages.next().await {
            match message {
                Ok(AsyncMessage::Notice(n)) => sink
                    .lock()
                    .push((n.severity().to_string(), n.message().to_string())),
                Ok(AsyncMessage::Notification(n)) => mailbox.lock().push(PgNotification {
                    channel: n.channel().to_string(),
                    payload: n.payload().to_string(),
                    pid: n.process_id(),
                    at: chrono::Utc::now().timestamp_millis(),
                }),
                Ok(_) => {}
                Err(e) => {
                    ended = Some(describe_error(&e));
                    break;
                }
            }
        }
        mailbox.lock().closed =
            Some(ended.unwrap_or_else(|| "The server closed the connection".into()));
    });

    if cfg.read_only {
        client
            .batch_execute("SET default_transaction_read_only = on")
            .await?;
    }
    let database = client
        .query_one("SELECT current_database()::text", &[])
        .await?
        .get::<_, String>(0);
    Ok(PgSession {
        client,
        tls,
        notices,
        inbox,
        database,
        task,
    })
}

/// CREATE MATERIALIZED VIEW with its access method, storage parameters and tablespace,
/// WITH NO DATA when it isn't populated, then its indexes and comments.
const MATVIEW_DDL: &str = "SELECT concat_ws(chr(10) || chr(10), \
     'CREATE MATERIALIZED VIEW ' || format('%I.%I', n.nspname, c.relname) \
       || CASE WHEN am.amname <> 'heap' THEN ' USING ' || quote_ident(am.amname) ELSE '' END \
       || CASE WHEN c.reloptions IS NOT NULL \
            THEN ' WITH (' || array_to_string(c.reloptions, ', ') || ')' ELSE '' END \
       || CASE WHEN c.reltablespace <> 0 THEN ' TABLESPACE ' || quote_ident(ts.spcname) ELSE '' END \
       || ' AS' || chr(10) || regexp_replace(pg_get_viewdef(c.oid, true), ';\\s*$', '') \
       || CASE WHEN c.relispopulated THEN ';' ELSE chr(10) || 'WITH NO DATA;' END, \
     (SELECT string_agg(pg_get_indexdef(i.indexrelid) || ';', chr(10) ORDER BY ic.relname) \
      FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid WHERE i.indrelid = c.oid), \
     (SELECT string_agg(x, chr(10) ORDER BY o) FROM ( \
        SELECT 0 AS o, format('COMMENT ON MATERIALIZED VIEW %I.%I IS %L;', n.nspname, c.relname, d.description) AS x \
        FROM pg_description d \
        WHERE d.objoid = c.oid AND d.classoid = 'pg_class'::regclass AND d.objsubid = 0 \
        UNION ALL \
        SELECT a.attnum, format('COMMENT ON COLUMN %I.%I.%I IS %L;', n.nspname, c.relname, a.attname, d.description) \
        FROM pg_attribute a \
        JOIN pg_description d ON d.objoid = c.oid AND d.classoid = 'pg_class'::regclass AND d.objsubid = a.attnum \
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) comments)) \
   FROM pg_class c \
   JOIN pg_namespace n ON n.oid = c.relnamespace \
   LEFT JOIN pg_am am ON am.oid = c.relam \
   LEFT JOIN pg_tablespace ts ON ts.oid = c.reltablespace \
   WHERE c.oid = format('%I.%I', $1::text, $2::text)::regclass";

impl PgSession {
    pub fn is_closed(&self) -> bool {
        self.client.is_closed()
    }

    /// `now()` is fixed at the start of the transaction, so it only differs from
    /// the statement's start inside a transaction block. Sent as one simple
    /// query: the extended protocol's separate messages would move the
    /// statement's start past an implicit transaction's.
    pub async fn in_transaction(&self) -> Option<bool> {
        match self
            .client
            .simple_query("SELECT now() <> statement_timestamp()")
            .await
        {
            Ok(messages) => messages.iter().find_map(|m| match m {
                SimpleQueryMessage::Row(row) => row.get(0).map(|v| v == "t"),
                _ => None,
            }),
            // A failed transaction block refuses everything until it ends
            Err(e)
                if e.code()
                    == Some(&tokio_postgres::error::SqlState::IN_FAILED_SQL_TRANSACTION) =>
            {
                Some(true)
            }
            Err(_) => None,
        }
    }

    /// The underlying client, for the built-in backup's COPY streams.
    pub fn client(&self) -> &Client {
        &self.client
    }

    pub async fn server_info(&self) -> AppResult<ServerInfo> {
        let row = self
            .client
            .query_one(
                "SELECT version(), current_database()::text, current_user::text, \
                 current_setting('server_version')",
                &[],
            )
            .await?;
        let version: String = row.get(0);
        let short: String = row.get(3);
        Ok(ServerInfo {
            product: format!(
                "PostgreSQL {}",
                short.split_whitespace().next().unwrap_or("")
            ),
            version,
            current_database: row.get(1),
            user: row.get(2),
            babelfish_version: None,
        })
    }

    /// Notifications received but not yet read, shared with the connection task.
    pub fn inbox(&self) -> Arc<Mutex<Inbox>> {
        self.inbox.clone()
    }

    /// Like psql, lists what arrived since the last statement, including while idle.
    fn flush_notifications(&self, out: &mut OutputBuilder) {
        let (items, dropped) = self.inbox.lock().take();
        for n in items.iter().take(NOTIFICATIONS_SHOWN) {
            out.message("notice", notification_line(n));
        }
        let more = items.len().saturating_sub(NOTIFICATIONS_SHOWN) as u64 + dropped;
        if more > 0 {
            out.message(
                "notice",
                format!(
                    "…and {more} more notification{}",
                    if more == 1 { "" } else { "s" }
                ),
            );
        }
    }

    fn flush_notices(&self, out: &mut OutputBuilder) {
        for (severity, text) in self.notices.lock().drain(..) {
            let level = if severity == "WARNING" {
                "warning"
            } else {
                "notice"
            };
            out.message(level, format!("{severity}: {text}"));
        }
    }

    pub async fn execute(
        &mut self,
        sql: &str,
        opts: &ExecOptions,
        cancel: &CancelSignal,
    ) -> ExecOutput {
        let mut out = OutputBuilder::new(opts);
        self.notices.lock().clear();
        if let Err(e) = self.run(sql, &mut out, cancel).await {
            let message = describe_error(&e);
            if out.cancelled {
                out.message("warning", message);
            } else {
                out.fail(message, error_position(&e), None);
            }
        }
        self.flush_notices(&mut out);
        self.flush_notifications(&mut out);

        // The simple protocol doesn't carry column types; a prepare (which never
        // executes) recovers them for the common single-statement case.
        if out.results.len() == 1 && out.error.is_none() {
            let prepared =
                tokio::time::timeout(Duration::from_secs(2), self.client.prepare(sql)).await;
            if let Ok(Ok(stmt)) = prepared {
                let set = &mut out.results[0];
                if stmt.columns().len() == set.columns.len() {
                    for (meta, col) in set.columns.iter_mut().zip(stmt.columns()) {
                        meta.type_name = col.type_().name().to_string();
                    }
                }
            }
        }
        out.finish(Some(self.database.clone()))
    }

    async fn run(
        &mut self,
        sql: &str,
        out: &mut OutputBuilder,
        cancel: &CancelSignal,
    ) -> Result<(), tokio_postgres::Error> {
        let stream = self.client.simple_query_raw(sql).await?;
        futures_util::pin_mut!(stream);
        loop {
            let next = tokio::select! {
                biased;
                _ = cancel.wait(), if !out.cancelled => {
                    out.cancelled = true;
                    let _ = self.client.cancel_token().cancel_query(self.tls.clone()).await;
                    continue;
                }
                next = stream.next() => next,
            };
            let Some(message) = next else { break };
            match message? {
                SimpleQueryMessage::RowDescription(columns) => out.begin_set(
                    columns
                        .iter()
                        .map(|c| ColumnMeta {
                            name: c.name().to_string(),
                            type_name: String::new(),
                        })
                        .collect(),
                ),
                SimpleQueryMessage::Row(row) => {
                    if out.wants_rows() {
                        let values = (0..row.len())
                            .map(|i| match row.get(i) {
                                Some(s) => Value::String(s.to_string()),
                                None => Value::Null,
                            })
                            .collect();
                        out.push_row(values);
                    } else {
                        out.skip_row();
                    }
                }
                SimpleQueryMessage::CommandComplete(n) => {
                    if out.has_open_set() {
                        out.end_set(Some(n));
                    } else {
                        out.affected(n);
                    }
                    self.flush_notices(out);
                }
                _ => {}
            }
        }
        // `USE` doesn't exist in PostgreSQL, but keep the label honest anyway
        if let Ok(row) = self
            .client
            .query_one("SELECT current_database()::text", &[])
            .await
        {
            self.database = row.get(0);
        }
        Ok(())
    }

    async fn strings(
        &self,
        sql: &str,
        params: &[&(dyn tokio_postgres::types::ToSql + Sync)],
    ) -> AppResult<Vec<tokio_postgres::Row>> {
        Ok(self.client.query(sql, params).await?)
    }

    pub async fn list_databases(&self) -> AppResult<Vec<DatabaseInfo>> {
        let rows = self
            .strings(
                "SELECT datname::text, datistemplate, \
                 CASE WHEN has_database_privilege(oid, 'CONNECT') THEN pg_database_size(oid) END \
                 FROM pg_database WHERE datallowconn ORDER BY datname",
                &[],
            )
            .await?;
        Ok(rows
            .iter()
            .map(|r| DatabaseInfo {
                name: r.get(0),
                is_system: r.get(1),
                size_bytes: r.get(2),
                keys: None,
            })
            .collect())
    }

    pub async fn list_schemas(&self) -> AppResult<Vec<SchemaInfo>> {
        let rows = self
            .strings(
                "SELECT nspname::text, nspname IN ('pg_catalog', 'information_schema') \
                 FROM pg_namespace \
                 WHERE nspname NOT LIKE 'pg\\_toast%' AND nspname NOT LIKE 'pg\\_temp\\_%' \
                 ORDER BY nspname IN ('pg_catalog', 'information_schema'), nspname",
                &[],
            )
            .await?;
        Ok(rows
            .iter()
            .map(|r| SchemaInfo {
                name: r.get(0),
                is_system: r.get(1),
            })
            .collect())
    }

    pub async fn list_objects(&self, schema: &str) -> AppResult<Vec<DbObject>> {
        let rows = self
            .strings(
                "SELECT c.relname::text, \
                   CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized_view' \
                     WHEN 'f' THEN 'foreign_table' WHEN 'S' THEN 'sequence' ELSE 'table' END, \
                   NULL::text, obj_description(c.oid, 'pg_class'), \
                   CASE WHEN c.relkind IN ('r', 'p', 'm') THEN c.reltuples::bigint END \
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') \
                   AND NOT c.relispartition \
                 UNION ALL \
                 SELECT p.proname::text, CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END, \
                   pg_get_function_identity_arguments(p.oid), obj_description(p.oid, 'pg_proc'), NULL \
                 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
                 WHERE n.nspname = $1 AND p.prokind IN ('f', 'p') \
                 ORDER BY 2, 1",
                &[&schema],
            )
            .await?;
        Ok(rows
            .iter()
            .map(|r| DbObject {
                schema: Some(schema.to_string()),
                name: r.get(0),
                kind: r.get(1),
                detail: r.get(2),
                comment: r.get(3),
                row_estimate: r.get::<_, Option<i64>>(4).filter(|n| *n >= 0),
            })
            .collect())
    }

    pub async fn describe_table(&self, schema: &str, table: &str) -> AppResult<TableInfo> {
        let columns = self
            .strings(
                "SELECT a.attname::text, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, \
                   pg_get_expr(d.adbin, d.adrelid), col_description(a.attrelid, a.attnum), \
                   a.attidentity <> '' OR a.attgenerated <> '' OR coalesce(pg_get_expr(d.adbin, d.adrelid), '') LIKE 'nextval(%', \
                   a.attidentity <> '' \
                 FROM pg_attribute a \
                 LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
                 WHERE a.attrelid = format('%I.%I', $1::text, $2::text)::regclass \
                   AND a.attnum > 0 AND NOT a.attisdropped \
                 ORDER BY a.attnum",
                &[&schema, &table],
            )
            .await?;
        let indexes = self
            .strings(
                "SELECT i.relname::text, ix.indisunique, ix.indisprimary, am.amname::text, \
                   ARRAY(SELECT pg_get_indexdef(ix.indexrelid, k, true) \
                         FROM generate_series(1, ix.indnkeyatts) k)::text[], \
                   pg_get_indexdef(ix.indexrelid) \
                 FROM pg_index ix \
                 JOIN pg_class i ON i.oid = ix.indexrelid \
                 JOIN pg_am am ON am.oid = i.relam \
                 WHERE ix.indrelid = format('%I.%I', $1::text, $2::text)::regclass \
                 ORDER BY ix.indisprimary DESC, i.relname",
                &[&schema, &table],
            )
            .await?;
        let fks = self
            .strings(
                "SELECT con.conname::text, \
                   ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(n, o) \
                         JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.o), \
                   nf.nspname::text, cf.relname::text, \
                   ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(n, o) \
                         JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.o), \
                   con.confupdtype::text, con.confdeltype::text \
                 FROM pg_constraint con \
                 JOIN pg_class cf ON cf.oid = con.confrelid \
                 JOIN pg_namespace nf ON nf.oid = cf.relnamespace \
                 WHERE con.conrelid = format('%I.%I', $1::text, $2::text)::regclass AND con.contype = 'f' \
                 ORDER BY con.conname",
                &[&schema, &table],
            )
            .await?;
        // tgtype bits: 1 row, 2 before, 4 insert, 8 delete, 16 update, 32 truncate, 64 instead
        let triggers = self
            .strings(
                "SELECT t.tgname::text, \
                   CASE WHEN t.tgtype::int & 2 <> 0 THEN 'BEFORE' \
                        WHEN t.tgtype::int & 64 <> 0 THEN 'INSTEAD OF' ELSE 'AFTER' END, \
                   array_remove(ARRAY[ \
                     CASE WHEN t.tgtype::int & 4 <> 0 THEN 'INSERT' END, \
                     CASE WHEN t.tgtype::int & 16 <> 0 THEN 'UPDATE' END, \
                     CASE WHEN t.tgtype::int & 8 <> 0 THEN 'DELETE' END, \
                     CASE WHEN t.tgtype::int & 32 <> 0 THEN 'TRUNCATE' END], NULL)::text[], \
                   t.tgtype::int & 1 <> 0, t.tgenabled <> 'D', pg_get_triggerdef(t.oid, true) \
                 FROM pg_trigger t \
                 WHERE t.tgrelid = format('%I.%I', $1::text, $2::text)::regclass AND NOT t.tgisinternal \
                 ORDER BY t.tgname",
                &[&schema, &table],
            )
            .await?;

        let indexes: Vec<IndexInfo> = indexes
            .iter()
            .map(|r| IndexInfo {
                name: r.get(0),
                unique: r.get(1),
                primary: r.get(2),
                method: r.get(3),
                columns: r.get(4),
                definition: r.get(5),
            })
            .collect();
        let primary_key = indexes
            .iter()
            .find(|i| i.primary)
            .map(|i| i.columns.clone())
            .unwrap_or_default();
        let action = |c: Option<String>| -> Option<String> {
            Some(
                match c.as_deref()? {
                    "a" => "NO ACTION",
                    "r" => "RESTRICT",
                    "c" => "CASCADE",
                    "n" => "SET NULL",
                    "d" => "SET DEFAULT",
                    other => other,
                }
                .to_string(),
            )
        };
        Ok(TableInfo {
            columns: columns
                .iter()
                .map(|r| {
                    let name: String = r.get(0);
                    ColumnInfo {
                        is_primary_key: primary_key.contains(&name),
                        name,
                        data_type: r.get(1),
                        nullable: r.get(2),
                        default: r.get(3),
                        comment: r.get(4),
                        is_generated: r.get(5),
                        is_identity: r.get(6),
                        extra: None,
                    }
                })
                .collect(),
            primary_key,
            indexes,
            foreign_keys: fks
                .iter()
                .map(|r| ForeignKeyInfo {
                    name: r.get(0),
                    columns: r.get(1),
                    ref_schema: r.get(2),
                    ref_table: r.get(3),
                    ref_columns: r.get(4),
                    on_update: action(r.get(5)),
                    on_delete: action(r.get(6)),
                })
                .collect(),
            triggers: triggers
                .iter()
                .map(|r| TriggerInfo {
                    name: r.get(0),
                    timing: r.get(1),
                    events: r.get(2),
                    row_level: r.get(3),
                    enabled: r.get(4),
                    definition: r.get(5),
                })
                .collect(),
        })
    }

    pub async fn object_definition(
        &self,
        schema: &str,
        name: &str,
        kind: &str,
        detail: Option<&str>,
    ) -> AppResult<Option<String>> {
        let sql = match kind {
            "table" => return self.table_definition(schema, name).await,
            "view" => {
                "SELECT 'CREATE OR REPLACE VIEW ' || format('%I.%I', $1::text, $2::text) || ' AS' || chr(10) \
                 || pg_get_viewdef(format('%I.%I', $1::text, $2::text)::regclass, true)"
            }
            "materialized_view" => MATVIEW_DDL,
            "function" | "procedure" => {
                let rows = self
                    .strings(
                        "SELECT pg_get_functiondef(p.oid) FROM pg_proc p \
                         JOIN pg_namespace n ON n.oid = p.pronamespace \
                         WHERE n.nspname = $1 AND p.proname = $2 \
                           AND pg_get_function_identity_arguments(p.oid) = $3",
                        &[&schema, &name, &detail.unwrap_or("")],
                    )
                    .await?;
                return Ok(rows.first().map(|r| r.get(0)));
            }
            "sequence" => {
                "SELECT format('CREATE SEQUENCE %I.%I AS %s INCREMENT BY %s MINVALUE %s MAXVALUE %s START WITH %s CACHE %s%s;', \
                   schemaname, sequencename, data_type, increment_by, min_value, max_value, start_value, cache_size, \
                   CASE WHEN cycle THEN ' CYCLE' ELSE '' END) \
                 FROM pg_sequences WHERE schemaname = $1 AND sequencename = $2"
            }
            _ => return Ok(None),
        };
        let rows = self.strings(sql, &[&schema, &name]).await?;
        Ok(rows.first().map(|r| r.get(0)))
    }

    pub async fn describe_routine(
        &self,
        schema: &str,
        name: &str,
        identity_args: &str,
    ) -> AppResult<RoutineInfo> {
        const FILTER: &str =
            "n.nspname = $1 AND p.proname = $2 AND pg_get_function_identity_arguments(p.oid) = $3";
        let head = self
            .strings(
                &format!(
                    "SELECT CASE WHEN p.prokind = 'p' THEN NULL ELSE pg_get_function_result(p.oid) END, l.lanname::text, \
                       p.prosecdef, CASE p.provolatile WHEN 'i' THEN 'IMMUTABLE' WHEN 's' THEN 'STABLE' ELSE 'VOLATILE' END, \
                       p.proisstrict, CASE p.proparallel WHEN 's' THEN 'SAFE' WHEN 'r' THEN 'RESTRICTED' ELSE 'UNSAFE' END, \
                       p.proleakproof, p.procost::float8, p.prorows::float8, coalesce(p.proconfig, '{{}}'::text[]) \
                     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
                     JOIN pg_language l ON l.oid = p.prolang WHERE {FILTER}"
                ),
                &[&schema, &name, &identity_args],
            )
            .await?;
        let Some(head) = head.first() else {
            return Err(AppError::msg(format!("{schema}.{name} no longer exists")));
        };
        let params = self
            .strings(
                &format!(
                    "SELECT coalesce(a.n, ''), format_type(a.t, NULL), \
                       CASE coalesce(a.m::text, 'i') WHEN 'o' THEN 'OUT' WHEN 'b' THEN 'INOUT' \
                         WHEN 'v' THEN 'VARIADIC' WHEN 't' THEN 'TABLE' ELSE 'IN' END \
                     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
                     CROSS JOIN LATERAL unnest(coalesce(p.proallargtypes, p.proargtypes::oid[]), \
                       coalesce(p.proargnames, '{{}}'::text[]), coalesce(p.proargmodes, '{{}}'::\"char\"[])) \
                       WITH ORDINALITY AS a(t, n, m, o) \
                     WHERE {FILTER} AND a.t IS NOT NULL ORDER BY a.o"
                ),
                &[&schema, &name, &identity_args],
            )
            .await?;
        Ok(RoutineInfo {
            params: params
                .iter()
                .map(|r| RoutineParam {
                    name: r.get(0),
                    data_type: r.get(1),
                    mode: r.get(2),
                })
                // Columns of RETURNS TABLE functions are part of the result, not inputs
                .filter(|p| p.mode != "TABLE")
                .collect(),
            returns: head.get(0),
            language: head.get(1),
            attributes: Some(RoutineAttributes {
                security_definer: head.get(2),
                volatility: head.get(3),
                strict: head.get(4),
                parallel: head.get(5),
                leakproof: head.get(6),
                cost: head.get(7),
                rows: head.get(8),
                config: head.get(9),
            }),
        })
    }

    pub async fn completion(&self) -> AppResult<Vec<CompletionTable>> {
        let rows = self
            .strings(
                // pg_catalog because information_schema.columns leaves out materialized
                // views; the privilege check is the same as that view's
                "SELECT n.nspname::text, c.relname::text, array_agg(a.attname::text ORDER BY a.attnum) \
                 FROM pg_attribute a \
                 JOIN pg_class c ON c.oid = a.attrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND a.attnum > 0 AND NOT a.attisdropped \
                   AND n.nspname NOT IN ('pg_catalog', 'information_schema') \
                   AND NOT pg_is_other_temp_schema(n.oid) \
                   AND (pg_has_role(c.relowner, 'USAGE') \
                     OR has_column_privilege(c.oid, a.attnum, 'SELECT, INSERT, UPDATE, REFERENCES')) \
                 GROUP BY 1, 2 ORDER BY 1, 2 LIMIT 5000",
                &[],
            )
            .await?;
        let mut tables: Vec<CompletionTable> = rows
            .iter()
            .map(|r| CompletionTable {
                schema: r.get(0),
                name: r.get(1),
                columns: r.get(2),
                foreign_keys: Vec::new(),
            })
            .collect();
        // Join suggestions are a bonus; completion works without them
        if let Ok(keys) = self
            .strings(
                "SELECT ns.nspname::text, cl.relname::text, co.oid::text, a.attname::text, \
                 rns.nspname::text, rcl.relname::text, ra.attname::text \
                 FROM pg_constraint co \
                 JOIN pg_class cl ON cl.oid = co.conrelid \
                 JOIN pg_namespace ns ON ns.oid = cl.relnamespace \
                 JOIN pg_class rcl ON rcl.oid = co.confrelid \
                 JOIN pg_namespace rns ON rns.oid = rcl.relnamespace \
                 CROSS JOIN LATERAL unnest(co.conkey, co.confkey) WITH ORDINALITY k(col, ref, i) \
                 JOIN pg_attribute a ON a.attrelid = co.conrelid AND a.attnum = k.col \
                 JOIN pg_attribute ra ON ra.attrelid = co.confrelid AND ra.attnum = k.ref \
                 WHERE co.contype = 'f' AND ns.nspname NOT IN ('pg_catalog', 'information_schema') \
                 ORDER BY 1, 2, 3, k.i LIMIT 20000",
                &[],
            )
            .await
        {
            attach_keys(
                &mut tables,
                keys.iter()
                    .map(|r| KeyColumn {
                        schema: r.get(0),
                        table: r.get(1),
                        key: r.get(2),
                        column: r.get(3),
                        ref_schema: r.get(4),
                        ref_table: r.get(5),
                        ref_column: r.get(6),
                    })
                    .collect(),
            );
        }
        Ok(tables)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(channel: &str, payload: &str) -> PgNotification {
        PgNotification {
            channel: channel.into(),
            payload: payload.into(),
            pid: 42,
            at: 0,
        }
    }

    #[test]
    fn formats_notifications_like_messages() {
        assert_eq!(
            notification_line(&note("jobs", "done")),
            "NOTIFY jobs (pid 42): done"
        );
        assert_eq!(notification_line(&note("jobs", "")), "NOTIFY jobs (pid 42)");
    }

    #[test]
    fn inbox_keeps_the_newest_and_counts_the_rest() {
        let mut inbox = Inbox::default();
        for i in 0..INBOX_CAPACITY + 5 {
            inbox.push(note("c", &i.to_string()));
        }
        let (items, dropped) = inbox.take();
        assert_eq!(items.len(), INBOX_CAPACITY);
        assert_eq!(dropped, 5);
        assert_eq!(items[0].payload, "5");
        let (items, dropped) = inbox.take();
        assert!(items.is_empty());
        assert_eq!(dropped, 0);
    }
}
