//! Open servers and their sessions.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

use crate::config::{ConnectionConfig, Engine};
use crate::drivers::{Session, mongo, pg_listen, redis};
use crate::error::{AppError, AppResult};
use crate::guard;
use crate::model::*;
use crate::tunnel;

/// Session key used by the object explorer and other background metadata calls.
pub const META: &str = "__meta";

/// Sessions idle longer than this get pinged before reuse.
const IDLE_CHECK: Duration = Duration::from_secs(60);

/// Cancels a statement that runs past `ExecOptions::timeout_secs`.
struct Deadline {
    secs: u64,
    fired: Arc<AtomicBool>,
    timer: tokio::task::JoinHandle<()>,
}

impl Deadline {
    fn arm(opts: &ExecOptions, signal: &Arc<CancelSignal>) -> Option<Self> {
        let secs = opts.timeout_secs.filter(|s| *s > 0)?;
        let fired = Arc::new(AtomicBool::new(false));
        let (flag, signal) = (fired.clone(), signal.clone());
        let timer = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(secs)).await;
            flag.store(true, Ordering::SeqCst);
            signal.fire();
        });
        Some(Self { secs, fired, timer })
    }

    /// Stops the timer; returns the limit when it was what cancelled the statement.
    fn disarm(self) -> Option<u64> {
        self.timer.abort();
        self.fired.load(Ordering::SeqCst).then_some(self.secs)
    }
}

fn timed_out_message(secs: u64) -> String {
    format!("Query timed out after {secs}s and was cancelled (see Settings → Results)")
}

pub struct Slot {
    pub session: Session,
    last_used: Instant,
    /// The session was put in read-only mode for AI assistant queries; cleared
    /// whenever the connection behind it is replaced
    read_only_mode: bool,
}

/// The MongoDB client, replaced when it stops answering after sitting idle.
struct MongoSlot {
    client: mongodb::Client,
    last_used: Instant,
}

pub struct Server {
    pub config: ConnectionConfig,
    password: Option<String>,
    mongo: Option<Mutex<MongoSlot>>,
    redis: Option<redis::RedisClient>,
    sessions: Mutex<HashMap<String, Arc<Mutex<Slot>>>>,
    running: parking_lot::Mutex<HashMap<String, Arc<CancelSignal>>>,
    /// Notifications tabs' LISTEN sessions
    pg_listeners: pg_listen::Listeners,
}

impl Server {
    fn default_database(&self) -> &str {
        &self.config.database
    }

    /// The password the connection was opened with, for client tools such as pg_dump.
    pub fn password(&self) -> Option<&str> {
        self.password.as_deref()
    }

    /// The MongoDB client, for the built-in backup.
    pub async fn mongo_client(&self) -> AppResult<mongodb::Client> {
        self.mongo().await
    }

    /// The MongoDB client, pinged first when it has sat idle. Sleep, a network
    /// change or a NAT timeout can leave its pooled sockets half-open, where
    /// requests wait forever instead of failing, so a client that doesn't answer
    /// is replaced (and a dropped tunnel restarted) like a stale SQL session.
    async fn mongo(&self) -> AppResult<mongodb::Client> {
        let slot = self
            .mongo
            .as_ref()
            .ok_or_else(|| AppError::Unsupported("Not a MongoDB connection".into()))?;
        let mut guard = slot.lock().await;
        if guard.last_used.elapsed() > IDLE_CHECK && !mongo::is_alive(&guard.client).await {
            tunnel::ensure(&self.config.id).await?;
            guard.client = mongo::connect(&self.config, self.password.as_deref()).await?;
        }
        guard.last_used = Instant::now();
        Ok(guard.client.clone())
    }

    fn redis(&self) -> AppResult<&redis::RedisClient> {
        self.redis
            .as_ref()
            .ok_or_else(|| AppError::Unsupported("Not a Redis connection".into()))
    }

    /// Gets (or opens) the session `key`, switched to `database`.
    pub async fn session(&self, key: &str, database: &str) -> AppResult<Arc<Mutex<Slot>>> {
        let database = if database.is_empty() {
            self.default_database()
        } else {
            database
        };
        // PostgreSQL connections are bound to one database, so metadata gets one per database
        let key = if self.config.engine == Engine::Postgres && key == META {
            format!("{META}:{database}")
        } else {
            key.to_string()
        };

        let existing = self.sessions.lock().await.get(&key).cloned();
        if let Some(slot) = existing {
            {
                let mut guard = slot.lock().await;
                let stale = guard.session.is_broken()
                    || (guard.last_used.elapsed() > IDLE_CHECK && !guard.session.is_alive().await);
                // Exact: PostgreSQL and MySQL names can differ only by case. SQL
                // Server's use_database ignores a switch that only changes case
                let wrong_db = !database.is_empty() && guard.session.database() != database;
                if stale || (wrong_db && matches!(guard.session, Session::Pg(_))) {
                    // A dropped SSH or Fly tunnel comes back on the same port
                    tunnel::ensure(&self.config.id).await?;
                    guard.session =
                        Session::connect(&self.config, self.password.as_deref(), database).await?;
                    guard.read_only_mode = false;
                } else if wrong_db {
                    match &mut guard.session {
                        Session::My(s) => s.use_database(database).await?,
                        Session::Ms(s) => s.use_database(database).await?,
                        // One database per SQLite connection
                        Session::Sq(_) => {}
                        Session::Pg(_) => {}
                    }
                }
                guard.last_used = Instant::now();
            }
            return Ok(slot);
        }

        tunnel::ensure(&self.config.id).await?;
        let session = Session::connect(&self.config, self.password.as_deref(), database).await?;
        let mut sessions = self.sessions.lock().await;
        // Another call opened this key while we connected: keep its session, which
        // may hold a transaction by now, and go through the checks above with it
        if sessions.contains_key(&key) {
            drop((sessions, session));
            return Box::pin(self.session(&key, database)).await;
        }
        let slot = Arc::new(Mutex::new(Slot {
            session,
            last_used: Instant::now(),
            read_only_mode: false,
        }));
        sessions.insert(key, slot.clone());
        Ok(slot)
    }

    pub async fn close_session(&self, key: &str) {
        self.sessions.lock().await.remove(key);
        if let Some(client) = &self.redis {
            client.close_session(key).await;
            client.unsubscribe(key);
        }
        self.pg_listeners.close(key).await;
    }

    fn begin(&self, key: &str) -> Arc<CancelSignal> {
        let signal = Arc::new(CancelSignal::default());
        self.running.lock().insert(key.to_string(), signal.clone());
        signal
    }

    fn end(&self, key: &str, signal: &Arc<CancelSignal>) {
        let mut running = self.running.lock();
        if running.get(key).is_some_and(|s| Arc::ptr_eq(s, signal)) {
            running.remove(key);
        }
    }

    pub fn cancel(&self, key: &str) {
        if let Some(signal) = self.running.lock().get(key) {
            signal.fire();
        }
    }

    pub async fn execute(
        &self,
        key: &str,
        database: &str,
        sql: &str,
        opts: &ExecOptions,
    ) -> AppResult<ExecOutput> {
        // First, so the assistant's refusals all read the same way
        if opts.assistant
            && let Some(keyword) = guard::assistant_blocked(sql, self.config.engine)
        {
            return Err(AppError::msg(format!(
                "SQL the AI assistant wrote can only read, and this uses {keyword}, so it was not run."
            )));
        }
        if (self.config.read_only || opts.read_only)
            && let Some(keyword) = guard::first_write_keyword(sql, self.config.engine)
        {
            return Err(AppError::msg(if self.config.read_only {
                format!(
                    "This connection is read-only, so {keyword} statements are blocked. \
                     Turn off \"Read-only\" in the connection settings to run them."
                )
            } else {
                format!("Only read-only queries can run here, and this one contains {keyword}.")
            }));
        }
        // Register before connecting so a cancel during connection setup isn't lost
        let signal = self.begin(key);
        let slot = match self.session(key, database).await {
            Ok(slot) => slot,
            Err(e) => {
                self.end(key, &signal);
                return Err(e);
            }
        };
        let output = if signal.is_fired() {
            let mut out = OutputBuilder::new(opts);
            out.cancelled = true;
            out.finish(None)
        } else {
            let mut guard = slot.lock().await;
            let deadline = Deadline::arm(opts, &signal);
            // Assistant SQL also runs in the server's read-only mode where there is
            // one, set once per connection (read-only connections already are)
            let setup = match self.config.engine {
                _ if !opts.assistant || self.config.read_only || guard.read_only_mode => None,
                Engine::Postgres => Some("SET default_transaction_read_only = on"),
                Engine::Mysql => Some("SET SESSION TRANSACTION READ ONLY"),
                _ => None,
            };
            let refused = match setup {
                Some(setup) => {
                    let out = guard
                        .session
                        .execute(setup, &ExecOptions::default(), &signal)
                        .await;
                    guard.read_only_mode = out.error.is_none();
                    out.error.is_some().then_some(out)
                }
                None => None,
            };
            let mut output = match refused {
                Some(mut out) => {
                    if let Some(error) = &mut out.error {
                        error.message = format!(
                            "Couldn't put the session in read-only mode, so the query was not run: {}",
                            error.message
                        );
                    }
                    out
                }
                None => guard.session.execute(sql, opts, &signal).await,
            };
            if let Some(secs) = deadline.and_then(Deadline::disarm) {
                let message = timed_out_message(secs);
                output.messages.push(Message {
                    level: "error",
                    text: message.clone(),
                    at_ms: output.elapsed_ms,
                });
                output.error.get_or_insert(ErrorDetail {
                    message,
                    position: None,
                    line: None,
                });
            }
            // Editor tabs show when they hold a transaction open
            if !key.starts_with(META) && !guard.session.is_broken() {
                output.in_transaction = guard.session.in_transaction().await;
            }
            guard.last_used = Instant::now();
            output
        };
        self.end(key, &signal);
        Ok(output)
    }

    pub async fn mongo_execute(
        &self,
        key: &str,
        request: mongo::MongoRequest,
        opts: &ExecOptions,
    ) -> AppResult<mongo::MongoOutput> {
        if self.config.read_only && request.is_write() {
            return Err(AppError::msg(
                "This connection is read-only. Turn off \"Read-only\" in the connection settings to modify data.",
            ));
        }
        if opts.read_only && request.is_write() {
            return Err(AppError::msg(
                "Only reads can run here: find, aggregate, count or distinct.",
            ));
        }
        if opts.assistant {
            let database = opts.assistant_database.as_deref().unwrap_or_default();
            if let Some(reason) = request.assistant_refusal(database) {
                return Err(AppError::msg(format!("{reason}, so it was not run.")));
            }
        }
        // Registered first so a cancel during the idle ping or reconnect counts;
        // `execute` returns at once on a signal that has already fired
        let signal = self.begin(key);
        let client = match self.mongo().await {
            Ok(client) => client,
            Err(e) => {
                self.end(key, &signal);
                return Err(e);
            }
        };
        let deadline = Deadline::arm(opts, &signal);
        let result = mongo::execute(&client, request, opts, &signal).await;
        self.end(key, &signal);
        match deadline.and_then(Deadline::disarm) {
            Some(secs) => Err(AppError::msg(timed_out_message(secs))),
            None => result,
        }
    }

    pub async fn redis_execute(
        &self,
        key: &str,
        request: redis::RedisRequest,
        opts: &ExecOptions,
    ) -> AppResult<redis::RedisOutput> {
        if self.config.read_only && request.is_write() {
            return Err(AppError::msg(
                "This connection is read-only, so commands that change data are blocked. \
                 Turn off \"Read-only\" in the connection settings to run them.",
            ));
        }
        let client = self.redis()?;
        let signal = self.begin(key);
        let deadline = Deadline::arm(opts, &signal);
        let result = redis::execute(client, key, request, &signal).await;
        self.end(key, &signal);
        match deadline.and_then(Deadline::disarm) {
            Some(secs) => Err(AppError::msg(timed_out_message(secs))),
            None => result,
        }
    }

    /// Starts forwarding Pub/Sub messages to `emit` under subscription `id`.
    pub async fn redis_subscribe(
        &self,
        id: String,
        channels: Vec<String>,
        patterns: Vec<String>,
        emit: impl Fn(redis::PubSubBatch) + Send + 'static,
    ) -> AppResult<()> {
        redis::subscribe(self.redis()?, id, channels, patterns, emit).await
    }

    pub fn redis_unsubscribe(&self, id: &str) {
        if let Some(client) = &self.redis {
            client.unsubscribe(id);
        }
    }

    /// LISTENs on `channels` from listener `id`'s own session, opened on `database`;
    /// notifications go to `emit`. Returns every channel the listener has.
    pub async fn pg_listen(
        &self,
        id: &str,
        database: &str,
        channels: Vec<String>,
        emit: impl Fn(pg_listen::NotifyBatch) + Send + 'static,
    ) -> AppResult<Vec<String>> {
        let database = if database.is_empty() {
            self.default_database()
        } else {
            database
        };
        self.pg_listeners
            .listen(
                &self.config,
                self.password.as_deref(),
                id,
                database,
                channels,
                emit,
            )
            .await
    }

    pub async fn pg_unlisten(&self, id: &str, channels: Vec<String>) -> AppResult<Vec<String>> {
        self.pg_listeners.unlisten(id, channels).await
    }

    pub async fn pg_notify(
        &self,
        id: &str,
        database: &str,
        channel: &str,
        payload: &str,
        emit: impl Fn(pg_listen::NotifyBatch) + Send + 'static,
    ) -> AppResult<()> {
        if self.config.read_only {
            return Err(AppError::msg(
                "This connection is read-only, so sending notifications is blocked.                  Turn off \"Read-only\" in the connection settings to send them.",
            ));
        }
        let database = if database.is_empty() {
            self.default_database()
        } else {
            database
        };
        self.pg_listeners
            .notify(
                &self.config,
                self.password.as_deref(),
                id,
                database,
                channel,
                payload,
                emit,
            )
            .await
    }

    /// Streams a whole find or pipeline result to `path`; cancelled like a query on `key`.
    pub async fn mongo_export(
        &self,
        key: &str,
        request: mongo::ExportRequest,
        path: &std::path::Path,
    ) -> AppResult<mongo::ExportSummary> {
        let signal = self.begin(key);
        let client = match self.mongo().await {
            Ok(client) => client,
            Err(e) => {
                self.end(key, &signal);
                return Err(e);
            }
        };
        let result = mongo::export(&client, request, path, &signal).await;
        self.end(key, &signal);
        result
    }

    pub async fn list_databases(&self) -> AppResult<Vec<DatabaseInfo>> {
        if self.mongo.is_some() {
            return mongo::list_databases(&self.mongo().await?).await;
        }
        if let Some(client) = &self.redis {
            return redis::list_databases(client).await;
        }
        let slot = self.session(META, "").await?;
        let mut guard = slot.lock().await;
        match &mut guard.session {
            Session::Pg(s) => s.list_databases().await,
            Session::My(s) => s.list_databases().await,
            Session::Ms(s) => s.list_databases().await,
            Session::Sq(s) => s.list_databases().await,
        }
    }

    pub async fn list_schemas(&self, database: &str) -> AppResult<Vec<SchemaInfo>> {
        let slot = self.session(META, database).await?;
        let mut guard = slot.lock().await;
        match &mut guard.session {
            Session::Pg(s) => s.list_schemas().await,
            Session::Ms(s) => s.list_schemas(database).await,
            Session::My(_) | Session::Sq(_) => Ok(Vec::new()),
        }
    }

    pub async fn list_objects(
        &self,
        database: &str,
        schema: Option<&str>,
    ) -> AppResult<Vec<DbObject>> {
        if self.mongo.is_some() {
            return mongo::list_collections(&self.mongo().await?, database).await;
        }
        // Keys are browsed in the key browser, a page at a time
        if self.redis.is_some() {
            return Ok(Vec::new());
        }
        let slot = self.session(META, database).await?;
        let mut guard = slot.lock().await;
        match &mut guard.session {
            Session::Pg(s) => s.list_objects(schema.unwrap_or("public")).await,
            Session::My(s) => s.list_objects(database).await,
            Session::Ms(s) => {
                let mut objects = s.list_objects(database).await?;
                if let Some(schema) = schema {
                    objects.retain(|o| o.schema.as_deref() == Some(schema));
                }
                Ok(objects)
            }
            Session::Sq(s) => s.list_objects().await,
        }
    }

    pub async fn describe_table(
        &self,
        database: &str,
        schema: Option<&str>,
        table: &str,
    ) -> AppResult<TableInfo> {
        let slot = self.session(META, database).await?;
        let mut guard = slot.lock().await;
        match &mut guard.session {
            Session::Pg(s) => s.describe_table(schema.unwrap_or("public"), table).await,
            Session::My(s) => s.describe_table(database, table).await,
            Session::Ms(s) => {
                s.describe_table(database, schema.unwrap_or("dbo"), table)
                    .await
            }
            Session::Sq(s) => s.describe_table(table).await,
        }
    }

    pub async fn object_definition(
        &self,
        database: &str,
        schema: Option<&str>,
        name: &str,
        kind: &str,
        detail: Option<&str>,
    ) -> AppResult<Option<String>> {
        let slot = self.session(META, database).await?;
        let mut guard = slot.lock().await;
        match &mut guard.session {
            Session::Pg(s) => {
                s.object_definition(schema.unwrap_or("public"), name, kind, detail)
                    .await
            }
            Session::My(s) => s.object_definition(database, name, kind).await,
            Session::Ms(s) => {
                s.object_definition(database, schema.unwrap_or("dbo"), name)
                    .await
            }
            Session::Sq(s) => s.object_definition(name).await,
        }
    }

    pub async fn describe_routine(
        &self,
        database: &str,
        schema: Option<&str>,
        name: &str,
        kind: &str,
        detail: Option<&str>,
    ) -> AppResult<RoutineInfo> {
        let slot = self.session(META, database).await?;
        let mut guard = slot.lock().await;
        match &mut guard.session {
            Session::Pg(s) => {
                s.describe_routine(schema.unwrap_or("public"), name, detail.unwrap_or(""))
                    .await
            }
            Session::My(s) => s.describe_routine(database, name, kind).await,
            Session::Ms(s) => {
                s.describe_routine(database, schema.unwrap_or("dbo"), name, kind)
                    .await
            }
            Session::Sq(_) => Err(AppError::Unsupported(
                "SQLite has no stored procedures or functions".into(),
            )),
        }
    }

    pub async fn completion(&self, database: &str) -> AppResult<Vec<CompletionTable>> {
        let slot = self.session(META, database).await?;
        let mut guard = slot.lock().await;
        match &mut guard.session {
            Session::Pg(s) => s.completion().await,
            Session::My(s) => s.completion(database).await,
            Session::Ms(s) => s.completion(database).await,
            Session::Sq(s) => s.completion().await,
        }
    }
}

#[derive(Default)]
pub struct Manager {
    servers: parking_lot::Mutex<HashMap<String, Arc<Server>>>,
}

/// What connecting produced: a client for MongoDB or Redis, a session for SQL engines.
// Opened once per connection, so variant size doesn't matter
#[allow(clippy::large_enum_variant)]
pub enum Opened {
    Mongo(mongodb::Client),
    Redis(redis::RedisClient),
    Sql(Session),
}

type Probed = (ServerInfo, Opened);

/// Connects without registering anything; used by "Test connection". A tunnel
/// the connection needs only lives for the test.
pub async fn probe(
    config: &ConnectionConfig,
    password: Option<&str>,
    ssh_secret: Option<&str>,
) -> AppResult<Probed> {
    let key = format!("probe:{}", uuid::Uuid::new_v4());
    let result = async {
        let config = tunnel::prepare(&key, config.clone(), ssh_secret).await?;
        probe_direct(&config, password).await
    }
    .await;
    tunnel::close(&key).await;
    result
}

async fn probe_direct(config: &ConnectionConfig, password: Option<&str>) -> AppResult<Probed> {
    match config.engine {
        Engine::Mongo => {
            let client = mongo::connect(config, password).await?;
            let info = mongo::server_info(&client).await?;
            Ok((info, Opened::Mongo(client)))
        }
        Engine::Redis => {
            let client = redis::connect(config, password).await?;
            let info = redis::server_info(&client).await?;
            Ok((info, Opened::Redis(client)))
        }
        _ => {
            let mut session = Session::connect(config, password, &config.database).await?;
            let info = session.server_info().await?;
            Ok((info, Opened::Sql(session)))
        }
    }
}

impl Manager {
    pub async fn open(
        &self,
        config: ConnectionConfig,
        password: Option<String>,
    ) -> AppResult<ServerInfo> {
        // A tunnel (Fly.io, SSH) stays up while the connection is open
        let id = config.id.clone();
        let config = tunnel::prepare(&id, config, None).await?;
        let (info, opened) = match probe_direct(&config, password.as_deref()).await {
            Ok(probed) => probed,
            Err(e) => {
                tunnel::close(&id).await;
                return Err(e);
            }
        };
        let (mut mongo, mut redis) = (None, None);
        let mut sessions = HashMap::new();
        match opened {
            Opened::Mongo(client) => {
                mongo = Some(Mutex::new(MongoSlot {
                    client,
                    last_used: Instant::now(),
                }))
            }
            Opened::Redis(client) => redis = Some(client),
            Opened::Sql(session) => {
                let key = if config.engine == Engine::Postgres {
                    format!("{META}:{}", session.database())
                } else {
                    META.to_string()
                };
                sessions.insert(
                    key,
                    Arc::new(Mutex::new(Slot {
                        session,
                        last_used: Instant::now(),
                        read_only_mode: false,
                    })),
                );
            }
        }
        let mut config = config;
        // Remember where the server put us so new tabs open in the same database
        if config.database.is_empty() {
            config.database = info.current_database.clone();
        }
        let server = Arc::new(Server {
            config,
            password,
            mongo,
            redis,
            sessions: Mutex::new(sessions),
            running: parking_lot::Mutex::new(HashMap::new()),
            pg_listeners: pg_listen::Listeners::default(),
        });
        let id = server.config.id.clone();
        self.servers.lock().insert(id, server);
        Ok(info)
    }

    pub fn get(&self, id: &str) -> AppResult<Arc<Server>> {
        self.servers
            .lock()
            .get(id)
            .cloned()
            .ok_or(AppError::NotConnected)
    }

    /// Returns once the connection's tunnel is down, so reopening right after
    /// starts a new one rather than reusing the one being closed.
    pub async fn close(&self, id: &str) {
        let server = self.servers.lock().remove(id);
        if let Some(server) = server {
            for signal in server.running.lock().values() {
                signal.fire();
            }
        }
        tunnel::close(id).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(timeout_secs: Option<u64>) -> ExecOptions {
        ExecOptions {
            timeout_secs,
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn deadline_fires_the_cancel_signal() {
        let signal = Arc::new(CancelSignal::default());
        let deadline = Deadline::arm(&opts(Some(1)), &signal).unwrap();
        tokio::time::timeout(Duration::from_secs(5), signal.wait())
            .await
            .unwrap();
        assert_eq!(deadline.disarm(), Some(1));
    }

    #[tokio::test]
    async fn disarmed_deadline_never_fires() {
        let signal = Arc::new(CancelSignal::default());
        let deadline = Deadline::arm(&opts(Some(1)), &signal).unwrap();
        assert_eq!(deadline.disarm(), None);
        tokio::time::sleep(Duration::from_millis(1200)).await;
        assert!(!signal.is_fired());
    }

    #[test]
    fn no_deadline_without_a_limit() {
        let signal = Arc::new(CancelSignal::default());
        assert!(Deadline::arm(&opts(None), &signal).is_none());
        assert!(Deadline::arm(&opts(Some(0)), &signal).is_none());
    }
}
