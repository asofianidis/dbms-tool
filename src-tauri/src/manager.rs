//! Open servers and their sessions.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

use crate::config::{ConnectionConfig, Engine};
use crate::drivers::{Session, mongo};
use crate::error::{AppError, AppResult};
use crate::guard;
use crate::model::*;
use crate::tunnel;

/// Session key used by the object explorer and other background metadata calls.
pub const META: &str = "__meta";

/// Sessions idle longer than this get pinged before reuse.
const IDLE_CHECK: Duration = Duration::from_secs(60);

pub struct Slot {
    pub session: Session,
    last_used: Instant,
}

pub struct Server {
    pub config: ConnectionConfig,
    password: Option<String>,
    mongo: Option<mongodb::Client>,
    sessions: Mutex<HashMap<String, Arc<Mutex<Slot>>>>,
    running: parking_lot::Mutex<HashMap<String, Arc<CancelSignal>>>,
}

impl Server {
    fn default_database(&self) -> &str {
        &self.config.database
    }

    /// The password the connection was opened with, for client tools such as pg_dump.
    pub fn password(&self) -> Option<&str> {
        self.password.as_deref()
    }

    fn mongo(&self) -> AppResult<&mongodb::Client> {
        self.mongo
            .as_ref()
            .ok_or_else(|| AppError::Unsupported("Not a MongoDB connection".into()))
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
                let wrong_db = !database.is_empty()
                    && !guard.session.database().eq_ignore_ascii_case(database);
                if stale || (wrong_db && matches!(guard.session, Session::Pg(_))) {
                    guard.session =
                        Session::connect(&self.config, self.password.as_deref(), database).await?;
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

        let session = Session::connect(&self.config, self.password.as_deref(), database).await?;
        let slot = Arc::new(Mutex::new(Slot {
            session,
            last_used: Instant::now(),
        }));
        self.sessions.lock().await.insert(key, slot.clone());
        Ok(slot)
    }

    pub async fn close_session(&self, key: &str) {
        self.sessions.lock().await.remove(key);
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
        if self.config.read_only
            && let Some(keyword) = guard::first_write_keyword(sql)
        {
            return Err(AppError::msg(format!(
                "This connection is read-only, so {keyword} statements are blocked. \
                     Turn off \"Read-only\" in the connection settings to run them."
            )));
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
            let output = guard.session.execute(sql, opts, &signal).await;
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
        let client = self.mongo()?;
        let signal = self.begin(key);
        let result = mongo::execute(client, request, opts, &signal).await;
        self.end(key, &signal);
        result
    }

    pub async fn list_databases(&self) -> AppResult<Vec<DatabaseInfo>> {
        if let Some(client) = &self.mongo {
            return mongo::list_databases(client).await;
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
        if let Some(client) = &self.mongo {
            return mongo::list_collections(client, database).await;
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

type Probed = (ServerInfo, Option<mongodb::Client>, Option<Session>);

/// Connects without registering anything; used by "Test connection". A tunnel
/// the connection needs only lives for the test.
pub async fn probe(config: &ConnectionConfig, password: Option<&str>) -> AppResult<Probed> {
    let key = format!("probe:{}", uuid::Uuid::new_v4());
    let result = async {
        let config = tunnel::prepare(&key, config.clone()).await?;
        probe_direct(&config, password).await
    }
    .await;
    tunnel::close(&key).await;
    result
}

async fn probe_direct(config: &ConnectionConfig, password: Option<&str>) -> AppResult<Probed> {
    if config.engine == Engine::Mongo {
        let client = mongo::connect(config, password).await?;
        let info = mongo::server_info(&client).await?;
        return Ok((info, Some(client), None));
    }
    let mut session = Session::connect(config, password, &config.database).await?;
    let info = session.server_info().await?;
    Ok((info, None, Some(session)))
}

impl Manager {
    pub async fn open(
        &self,
        config: ConnectionConfig,
        password: Option<String>,
    ) -> AppResult<ServerInfo> {
        // A tunnel (Fly.io) stays up while the connection is open
        let id = config.id.clone();
        let config = tunnel::prepare(&id, config).await?;
        let (info, mongo, session) = match probe_direct(&config, password.as_deref()).await {
            Ok(probed) => probed,
            Err(e) => {
                tunnel::close(&id).await;
                return Err(e);
            }
        };
        let mut sessions = HashMap::new();
        if let Some(session) = session {
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
                })),
            );
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
            sessions: Mutex::new(sessions),
            running: parking_lot::Mutex::new(HashMap::new()),
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

    pub fn close(&self, id: &str) {
        if let Some(server) = self.servers.lock().remove(id) {
            for signal in server.running.lock().values() {
                signal.fire();
            }
        }
        let id = id.to_string();
        tauri::async_runtime::spawn(async move { tunnel::close(&id).await });
    }
}
