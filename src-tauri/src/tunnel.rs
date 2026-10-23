//! Local tunnels for databases that live on a private network, such as Fly.io
//! Managed Postgres (reachable only through `fly mpg proxy`). A tunnel runs for
//! as long as its connection is open; sessions connect to its local port.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tokio::io::AsyncReadExt as _;
use tokio::process::Child;

use crate::cloud::{self, Provider};
use crate::config::{ConnectionConfig, SslMode};
use crate::error::{AppError, AppResult};

/// How long the proxy gets to start listening (it signs in to Fly's network first).
const READY_TIMEOUT: Duration = Duration::from_secs(45);

struct Tunnel {
    /// Killed when dropped
    child: Child,
    port: u16,
}

static TUNNELS: LazyLock<tokio::sync::Mutex<HashMap<String, Tunnel>>> =
    LazyLock::new(Default::default);

#[derive(Deserialize)]
struct CloudRef {
    provider: Provider,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    resource: String,
}

/// The cluster to tunnel to, when the connection needs one.
fn target(config: &ConnectionConfig) -> Option<CloudRef> {
    let cloud: CloudRef = serde_json::from_value(config.cloud.clone()?).ok()?;
    (cloud.provider == Provider::Fly && cloud.kind == "mpg" && !cloud.resource.is_empty())
        .then_some(cloud)
}

/// Asks the OS for a free local port. Another process could take it before the
/// proxy binds, which shows up as the proxy failing to start.
fn free_port() -> AppResult<u16> {
    Ok(std::net::TcpListener::bind("127.0.0.1:0")?
        .local_addr()?
        .port())
}

async fn start(cluster: &str) -> AppResult<Tunnel> {
    let port = free_port()?;
    let mut child = cloud::command(Provider::Fly)?
        .args(["mpg", "proxy", cluster, "--local-port", &port.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            let mut stderr = String::new();
            if let Some(mut pipe) = child.stderr.take() {
                let _ = pipe.read_to_string(&mut stderr).await;
            }
            let detail = stderr.trim();
            return Err(AppError::msg(if detail.is_empty() {
                format!("fly mpg proxy exited ({status})")
            } else {
                format!("fly mpg proxy failed: {detail}")
            }));
        }
        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok()
        {
            return Ok(Tunnel { child, port });
        }
        if started.elapsed() > READY_TIMEOUT {
            return Err(AppError::msg(
                "Timed out waiting for fly mpg proxy to start listening",
            ));
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

/// Starts (or reuses) the tunnel for `key` when `config` needs one, and
/// returns the config pointed at it. Other configs come back unchanged.
pub async fn prepare(key: &str, config: ConnectionConfig) -> AppResult<ConnectionConfig> {
    let Some(cloud) = target(&config) else {
        return Ok(config);
    };
    let mut tunnels = TUNNELS.lock().await;
    let alive = match tunnels.get_mut(key) {
        Some(t) => t.child.try_wait()?.is_none(),
        None => false,
    };
    if !alive {
        tunnels.insert(key.to_string(), start(&cloud.resource).await?);
    }
    let port = tunnels[key].port;
    Ok(ConnectionConfig {
        host: "127.0.0.1".into(),
        port,
        // The proxy carries the connection over Fly's private WireGuard network;
        // the server's certificate names the cluster, not 127.0.0.1
        ssl: SslMode::Prefer,
        trust_server_certificate: true,
        ..config
    })
}

/// Stops the tunnel for `key`, if there is one.
pub async fn close(key: &str) {
    TUNNELS.lock().await.remove(key);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(cloud: serde_json::Value) -> ConnectionConfig {
        serde_json::from_value(serde_json::json!({
            "id": "c", "name": "c", "engine": "postgres", "host": "h", "port": 5432,
            "cloud": cloud
        }))
        .unwrap()
    }

    #[test]
    fn only_fly_managed_postgres_needs_a_tunnel() {
        let fly =
            config(serde_json::json!({ "provider": "fly", "kind": "mpg", "resource": "abc" }));
        assert_eq!(target(&fly).map(|c| c.resource), Some("abc".into()));
        let aws =
            config(serde_json::json!({ "provider": "aws", "kind": "instance", "resource": "x" }));
        assert!(target(&aws).is_none());
        assert!(target(&config(serde_json::Value::Null)).is_none());
    }

    #[tokio::test]
    async fn other_connections_pass_through() {
        let plain = config(serde_json::Value::Null);
        let out = prepare("k", plain.clone()).await.unwrap();
        assert_eq!((out.host, out.port), (plain.host, plain.port));
    }
}
