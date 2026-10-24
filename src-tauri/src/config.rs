//! Saved connections. Settings live in `connections.json` in the app config
//! directory; passwords live in the OS credential store, never on disk.

use std::path::PathBuf;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

pub(crate) const KEYRING_SERVICE: &str = "dbms-tool";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Postgres,
    Mysql,
    Mssql,
    Babelfish,
    Mongo,
    /// Local database files and Cloudflare D1
    Sqlite,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SslMode {
    Disable,
    #[default]
    Prefer,
    /// Encrypt; the drivers also verify the certificate unless
    /// `trust_server_certificate` is set
    Require,
    /// Encrypt and verify the certificate chain, but not the host name
    #[serde(rename = "verify-ca")]
    VerifyCa,
    /// Encrypt and verify the certificate chain and the host name
    #[serde(rename = "verify-full")]
    VerifyFull,
}

impl SslMode {
    /// TLS must succeed; never falls back to plain text
    pub fn required(self) -> bool {
        matches!(
            self,
            SslMode::Require | SslMode::VerifyCa | SslMode::VerifyFull
        )
    }

    /// The verify modes, which ignore `trust_server_certificate`
    pub fn verifies(self) -> bool {
        matches!(self, SslMode::VerifyCa | SslMode::VerifyFull)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AuthMode {
    /// User name and password
    #[default]
    Password,
    /// Windows integrated authentication (SQL Server only)
    Windows,
    /// Short-lived token from the cloud provider's CLI: AWS IAM, Google Cloud
    /// IAM or Microsoft Entra ID (see `cloud::database_token`)
    Cloud,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SshAuth {
    /// Whatever `ssh` would use on its own: the agent, default keys, ~/.ssh/config
    #[default]
    Agent,
    /// A private key file, with an optional passphrase
    Key,
    Password,
}

/// An SSH server to tunnel the database connection through (see `tunnel.rs`).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    /// Kept off rather than removed so the settings survive toggling
    #[serde(default)]
    pub enabled: bool,
    /// Host name or a `Host` alias from ~/.ssh/config
    #[serde(default)]
    pub host: String,
    /// 0 for ssh's default (22, or the alias's `Port`)
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub auth: SshAuth,
    #[serde(default)]
    pub key_file: String,
    /// `ssh -J` destinations, e.g. `user@bastion:22`
    #[serde(default)]
    pub jump_host: String,
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
    /// Skip certificate checks in Prefer / Require; the verify modes ignore it
    #[serde(default)]
    pub trust_server_certificate: bool,
    /// CA certificate(s) to trust in addition to the system roots (PEM file)
    #[serde(default)]
    pub ssl_root_cert: String,
    /// Client certificate for mutual TLS (PEM, or a PKCS#12 `.p12`/`.pfx` bundle)
    #[serde(default)]
    pub ssl_client_cert: String,
    /// Private key for `ssl_client_cert` (PEM, PKCS#8)
    #[serde(default)]
    pub ssl_client_key: String,
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
    /// Opaque to the backend; the cloud resource this connection was found in
    /// or provisioned as
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloud: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh: Option<SshConfig>,
    /// The real host and port when `host`/`port` point at a local tunnel
    #[serde(skip)]
    pub tunneled: Option<(String, u16)>,
}

impl ConnectionConfig {
    pub fn ssh_tunnel(&self) -> Option<&SshConfig> {
        self.ssh.as_ref().filter(|s| s.enabled)
    }

    /// Whether the server certificate chain must be valid
    pub fn verify_certificate(&self) -> bool {
        match self.ssl {
            SslMode::Disable | SslMode::Prefer => false,
            SslMode::Require => !self.trust_server_certificate,
            SslMode::VerifyCa | SslMode::VerifyFull => true,
        }
    }

    /// Whether the certificate must also name the server
    pub fn verify_hostname(&self) -> bool {
        self.verify_certificate() && self.ssl != SslMode::VerifyCa
    }

    pub fn root_cert(&self) -> Option<&str> {
        Some(self.ssl_root_cert.trim()).filter(|s| !s.is_empty())
    }

    pub fn client_cert(&self) -> Option<&str> {
        Some(self.ssl_client_cert.trim()).filter(|s| !s.is_empty())
    }

    pub fn client_key(&self) -> Option<&str> {
        Some(self.ssl_client_key.trim()).filter(|s| !s.is_empty())
    }
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

/// Credential-store key for a connection's SSH password or key passphrase.
pub fn ssh_secret_id(id: &str) -> String {
    format!("{id}#ssh")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssl_modes_keep_their_json_names() {
        for (mode, json) in [
            (SslMode::Disable, "\"disable\""),
            (SslMode::Prefer, "\"prefer\""),
            (SslMode::Require, "\"require\""),
            (SslMode::VerifyCa, "\"verify-ca\""),
            (SslMode::VerifyFull, "\"verify-full\""),
        ] {
            assert_eq!(serde_json::to_string(&mode).unwrap(), json);
            assert_eq!(serde_json::from_str::<SslMode>(json).unwrap(), mode);
        }
    }

    #[test]
    fn saved_connections_without_tls_files_still_load() {
        let c: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "x", "name": "x", "engine": "mysql", "ssl": "require",
            "trustServerCertificate": true
        }))
        .unwrap();
        assert_eq!(c.ssl, SslMode::Require);
        assert_eq!(
            (c.root_cert(), c.client_cert(), c.client_key()),
            (None, None, None)
        );
        let json = serde_json::to_value(&c).unwrap();
        assert_eq!(json["sslRootCert"], "");
        assert_eq!(json["sslClientKey"], "");
    }
}
