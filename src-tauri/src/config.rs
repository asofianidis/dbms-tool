//! Saved connections. Settings live in `connections.json` in the app config
//! directory; passwords live in the OS credential store, never on disk.

use std::path::PathBuf;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const KEYRING_SERVICE: &str = "dbms-tool";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Postgres,
    Mysql,
    Mssql,
    Babelfish,
    Mongo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SslMode {
    Disable,
    #[default]
    Prefer,
    Require,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AuthMode {
    /// User name and password
    #[default]
    Password,
    /// Windows integrated authentication (SQL Server only)
    Windows,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    pub engine: Engine,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub user: String,
    /// Default database to open
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub auth: AuthMode,
    #[serde(default)]
    pub ssl: SslMode,
    #[serde(default)]
    pub trust_server_certificate: bool,
    /// MongoDB connection string; when set it takes precedence over host/port
    #[serde(default)]
    pub uri: String,
    /// MongoDB authentication database
    #[serde(default)]
    pub auth_source: String,
    #[serde(default)]
    pub save_password: bool,
    /// Blocks writes from the query editor and data grid
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub group: String,
    /// Opaque to the backend; the frontend sorts by it
    #[serde(default)]
    pub last_used: Option<i64>,
}

#[derive(Default, Serialize, Deserialize)]
struct StoreFile {
    #[serde(default)]
    connections: Vec<ConnectionConfig>,
}

pub struct ConnectionStore {
    path: PathBuf,
    connections: Mutex<Vec<ConnectionConfig>>,
}

impl ConnectionStore {
    pub fn load(dir: PathBuf) -> Self {
        let path = dir.join("connections.json");
        let connections = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<StoreFile>(&s).ok())
            .map(|f| f.connections)
            .unwrap_or_default();
        Self {
            path,
            connections: Mutex::new(connections),
        }
    }

    pub fn list(&self) -> Vec<ConnectionConfig> {
        self.connections.lock().clone()
    }

    pub fn get(&self, id: &str) -> AppResult<ConnectionConfig> {
        self.connections
            .lock()
            .iter()
            .find(|c| c.id == id)
            .cloned()
            .ok_or(AppError::UnknownConnection)
    }

    pub fn upsert(&self, mut config: ConnectionConfig) -> AppResult<ConnectionConfig> {
        if config.id.is_empty() {
            config.id = uuid::Uuid::new_v4().to_string();
        }
        let mut list = self.connections.lock();
        match list.iter_mut().find(|c| c.id == config.id) {
            Some(existing) => *existing = config.clone(),
            None => list.push(config.clone()),
        }
        self.persist(&list)?;
        Ok(config)
    }

    pub fn remove(&self, id: &str) -> AppResult<()> {
        let mut list = self.connections.lock();
        list.retain(|c| c.id != id);
        self.persist(&list)
    }

    pub fn touch(&self, id: &str) {
        let mut list = self.connections.lock();
        if let Some(c) = list.iter_mut().find(|c| c.id == id) {
            c.last_used = Some(chrono::Utc::now().timestamp_millis());
            let _ = self.persist(&list);
        }
    }

    fn persist(&self, list: &[ConnectionConfig]) -> AppResult<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let file = StoreFile {
            connections: list.to_vec(),
        };
        // Write then rename so a crash never leaves a truncated file behind
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&file)?)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

fn keyring_entry(id: &str) -> AppResult<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, id)
        .map_err(|e| AppError::msg(format!("Credential store unavailable: {e}")))
}

pub fn load_password(id: &str) -> Option<String> {
    keyring_entry(id).ok()?.get_password().ok()
}

pub fn store_password(id: &str, password: &str) -> AppResult<()> {
    keyring_entry(id)?
        .set_password(password)
        .map_err(|e| AppError::msg(format!("Could not save password: {e}")))
}

pub fn delete_password(id: &str) {
    if let Ok(entry) = keyring_entry(id) {
        let _ = entry.delete_credential();
    }
}
