//! Local tunnels for databases that aren't directly reachable: Fly.io Managed
//! Postgres (only reachable through `fly mpg proxy`) and anything behind an SSH
//! server (`ssh -L`). A tunnel runs for as long as its connection is open;
//! sessions connect to its local port.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tokio::io::AsyncReadExt as _;
use tokio::process::{Child, Command};

use crate::cloud::{self, Provider};
use crate::config::{self, ConnectionConfig, Engine, SshAuth, SshConfig, SslMode};
use crate::error::{AppError, AppResult};

/// How long a tunnel gets to start listening (the Fly proxy signs in to Fly's
/// network first; SSH may go through a jump host).
const READY_TIMEOUT: Duration = Duration::from_secs(45);

/// Set on `ssh` (and inherited by the askpass helper it starts) to the SSH
/// password or key passphrase; see `answer_askpass`.
const ASKPASS_ENV: &str = "DBMS_TOOL_SSH_ASKPASS";

struct Tunnel {
    /// Killed when dropped
    child: Child,
    port: u16,
    /// Enough to restart the tunnel on the same port if it dies
    target: Target,
    config: ConnectionConfig,
    secret: Option<String>,
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
    #[serde(default)]
    account: String,
}

enum Target {
    Fly { cluster: String, account: String },
    Ssh(SshConfig),
}

/// The tunnel the connection needs, if any.
fn target(config: &ConnectionConfig) -> Option<Target> {
    if let Some(cloud) = config
        .cloud
        .clone()
        .and_then(|c| serde_json::from_value::<CloudRef>(c).ok())
        && cloud.provider == Provider::Fly
        && cloud.kind == "mpg"
        && !cloud.resource.is_empty()
    {
        return Some(Target::Fly {
            cluster: cloud.resource,
            account: cloud.account,
        });
    }
    if config.engine == Engine::Sqlite {
        return None;
    }
    config.ssh_tunnel().cloned().map(Target::Ssh)
}

/// Asks the OS for a free local port. Another process could take it before the
/// tunnel binds, which shows up as the tunnel failing to start.
fn free_port() -> AppResult<u16> {
    Ok(std::net::TcpListener::bind("127.0.0.1:0")?
        .local_addr()?
        .port())
}

fn default_port(engine: Engine) -> u16 {
    match engine {
        Engine::Postgres => 5432,
        Engine::Mysql => 3306,
        Engine::Mongo => 27017,
        _ => 1433,
    }
}

/// Rejects values `ssh` would read as options.
fn ssh_arg<'a>(value: &'a str, what: &str) -> AppResult<&'a str> {
    if value.starts_with('-') {
        return Err(AppError::msg(format!(
            "The SSH {what} can't start with '-'"
        )));
    }
    Ok(value)
}

/// `ssh -N -L 127.0.0.1:<port>:<db host>:<db port> <server>`
fn ssh_command(
    ssh: &SshConfig,
    config: &ConnectionConfig,
    secret: Option<&str>,
    port: u16,
) -> AppResult<Command> {
    if ssh.host.trim().is_empty() {
        return Err(AppError::msg("Enter the SSH server to tunnel through"));
    }
    if config.engine == Engine::Mongo && !config.uri.trim().is_empty() {
        return Err(AppError::msg(
            "SSH tunnels need the host and port form of a MongoDB connection, not a connection string",
        ));
    }
    if matches!(config.engine, Engine::Mssql | Engine::Babelfish) && config.host.contains('\\') {
        return Err(AppError::msg(
            "Named SQL Server instances can't be reached through an SSH tunnel; enter the instance's port instead",
        ));
    }
    // Resolved on the SSH server, so localhost means the server itself
    let host = match config.host.trim() {
        "" => "localhost",
        h => h,
    };
    let host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    let db_port = match config.port {
        0 => default_port(config.engine),
        p => p,
    };

    let mut cmd = Command::new("ssh");
    cmd.args([
        "-N",
        "-T",
        "-L",
        &format!("127.0.0.1:{port}:{host}:{db_port}"),
    ])
    .args(["-o", "ExitOnForwardFailure=yes"])
    .args([
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=3",
    ])
    .args(["-o", "ConnectTimeout=15"])
    // There's no terminal to confirm a new host key on; a changed key still fails
    .args(["-o", "StrictHostKeyChecking=accept-new"]);
    if ssh.port != 0 {
        cmd.args(["-p", &ssh.port.to_string()]);
    }
    if !ssh.user.trim().is_empty() {
        cmd.args(["-l", ssh_arg(ssh.user.trim(), "user")?]);
    }
    if !ssh.jump_host.trim().is_empty() {
        cmd.args(["-J", ssh_arg(ssh.jump_host.trim(), "jump host")?]);
    }
    match ssh.auth {
        SshAuth::Agent => {}
        SshAuth::Key => {
            if ssh.key_file.trim().is_empty() {
                return Err(AppError::msg(
                    "Choose the private key file for the SSH tunnel",
                ));
            }
            cmd.args(["-i", ssh.key_file.trim(), "-o", "IdentitiesOnly=yes"]);
        }
        SshAuth::Password => {
            if secret.is_none() {
                return Err(AppError::msg("Enter the SSH password"));
            }
            cmd.args([
                "-o",
                "PreferredAuthentications=password,keyboard-interactive",
                "-o",
                "PubkeyAuthentication=no",
            ]);
        }
    }
    match secret.filter(|s| !s.is_empty() && ssh.auth != SshAuth::Agent) {
        // ssh asks this app (run as its askpass helper) for the password or passphrase
        Some(secret) => {
            let exe = std::env::current_exe()?;
            cmd.env("SSH_ASKPASS", exe)
                .env("SSH_ASKPASS_REQUIRE", "force")
                .env(ASKPASS_ENV, secret);
            // OpenSSH before 8.4 ignores SSH_ASKPASS_REQUIRE and wants DISPLAY instead
            if std::env::var_os("DISPLAY").is_none() {
                cmd.env("DISPLAY", "dbms-tool");
            }
        }
        // Fail instead of waiting for a prompt nobody can answer
        None => {
            cmd.args(["-o", "BatchMode=yes"]);
        }
    }
    cmd.arg(ssh_arg(ssh.host.trim(), "server")?);
    Ok(cmd)
}

/// When this process was started by `ssh` as its askpass helper, prints the
/// secret and returns `true`; the caller should then exit without starting the app.
pub fn answer_askpass() -> bool {
    use std::io::Write as _;
    let Some(secret) = std::env::var_os(ASKPASS_ENV) else {
        return false;
    };
    let mut out = std::io::stdout();
    let _ = writeln!(out, "{}", secret.to_string_lossy());
    let _ = out.flush();
    true
}

fn command(
    target: &Target,
    config: &ConnectionConfig,
    secret: Option<&str>,
    port: u16,
) -> AppResult<(Command, &'static str)> {
    let mut cmd = match target {
        Target::Fly { cluster, account } => {
            let mut cmd = cloud::command(Provider::Fly, account)?;
            cmd.args(["mpg", "proxy", cluster, "--local-port", &port.to_string()]);
            return Ok((cmd, "fly mpg proxy"));
        }
        Target::Ssh(ssh) => ssh_command(ssh, config, secret, port)?,
    };
    cmd.kill_on_drop(true).stdin(Stdio::null());
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    Ok((cmd, "SSH tunnel"))
}

async fn start(
    target: Target,
    config: ConnectionConfig,
    secret: Option<String>,
    port: u16,
) -> AppResult<Tunnel> {
    let (mut cmd, label) = command(&target, &config, secret.as_deref(), port)?;
    let mut child = cmd
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound if matches!(target, Target::Ssh(_)) => AppError::msg(
                "SSH tunnels need the OpenSSH client (ssh), which wasn't found on PATH",
            ),
            _ => e.into(),
        })?;
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            let mut stderr = String::new();
            if let Some(mut pipe) = child.stderr.take() {
                let _ = pipe.read_to_string(&mut stderr).await;
            }
            let detail = stderr.trim();
            return Err(AppError::msg(if detail.is_empty() {
                format!("{label} exited ({status})")
            } else {
                format!("{label} failed: {detail}")
            }));
        }
        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok()
        {
            // Keep draining so a chatty process never blocks on a full pipe
            if let Some(mut pipe) = child.stderr.take() {
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    while matches!(pipe.read(&mut buf).await, Ok(n) if n > 0) {}
                });
            }
            return Ok(Tunnel {
                child,
                port,
                target,
                config,
                secret,
            });
        }
        if started.elapsed() > READY_TIMEOUT {
            return Err(AppError::msg(format!(
                "Timed out waiting for the {label} to start listening"
            )));
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

/// Starts (or reuses) the tunnel for `key` when `config` needs one, and
/// returns the config pointed at it. Other configs come back unchanged.
/// `ssh_secret` overrides the SSH password or passphrase saved for the connection.
pub async fn prepare(
    key: &str,
    config: ConnectionConfig,
    ssh_secret: Option<&str>,
) -> AppResult<ConnectionConfig> {
    let Some(target) = target(&config) else {
        return Ok(config);
    };
    let fly = matches!(target, Target::Fly { .. });
    let mut tunnels = TUNNELS.lock().await;
    let alive = match tunnels.get_mut(key) {
        Some(t) => t.child.try_wait()?.is_none(),
        None => false,
    };
    if !alive {
        let secret = match ssh_secret {
            Some(s) if !s.is_empty() => Some(s.to_string()),
            _ if config.id.is_empty() => None,
            _ => config::load_password(&config::ssh_secret_id(&config.id)),
        };
        let tunnel = start(target, config.clone(), secret, free_port()?).await?;
        tunnels.insert(key.to_string(), tunnel);
    }
    let port = tunnels[key].port;
    let origin = (
        // What `ssh -L` forwards to; an empty host means the SSH server itself
        match config.host.trim() {
            "" => "localhost".to_string(),
            h => h.to_string(),
        },
        match config.port {
            0 => default_port(config.engine),
            p => p,
        },
    );
    Ok(ConnectionConfig {
        host: "127.0.0.1".into(),
        port,
        ssl: if fly { SslMode::Prefer } else { config.ssl },
        // The certificate names the server, not 127.0.0.1. The PostgreSQL and
        // MySQL drivers check it against `tunneled`; the SQL Server and MongoDB
        // drivers can only check the name they connect to, so they skip the check.
        trust_server_certificate: config.trust_server_certificate
            || !matches!(config.engine, Engine::Postgres | Engine::Mysql),
        tunneled: Some(origin),
        ..config
    })
}

/// Restarts the tunnel for `key` on its old port if it has died (network drop,
/// sleep), so sessions can reconnect. No-op for connections without one.
pub async fn ensure(key: &str) -> AppResult<()> {
    let mut tunnels = TUNNELS.lock().await;
    let Some(tunnel) = tunnels.get_mut(key) else {
        return Ok(());
    };
    if tunnel.child.try_wait()?.is_none() {
        return Ok(());
    }
    let Tunnel {
        port,
        target,
        config,
        secret,
        ..
    } = tunnels.remove(key).expect("checked above");
    let restarted = start(target, config, secret, port).await?;
    tunnels.insert(key.to_string(), restarted);
    Ok(())
}

/// Stops the tunnel for `key`, if there is one.
pub async fn close(key: &str) {
    TUNNELS.lock().await.remove(key);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(extra: serde_json::Value) -> ConnectionConfig {
        let mut base = serde_json::json!({
            "id": "c", "name": "c", "engine": "postgres", "host": "h", "port": 5432
        });
        base.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value(base).unwrap()
    }

    fn args(cmd: &Command) -> Vec<String> {
        cmd.as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn only_fly_managed_postgres_needs_a_cloud_tunnel() {
        let fly = config(serde_json::json!({
            "cloud": { "provider": "fly", "kind": "mpg", "resource": "abc" }
        }));
        assert!(matches!(target(&fly), Some(Target::Fly { cluster, .. }) if cluster == "abc"));
        let aws = config(serde_json::json!({
            "cloud": { "provider": "aws", "kind": "instance", "resource": "x" }
        }));
        assert!(target(&aws).is_none());
        assert!(target(&config(serde_json::json!({}))).is_none());
    }

    #[test]
    fn ssh_tunnel_only_when_enabled() {
        let off = config(serde_json::json!({ "ssh": { "enabled": false, "host": "b" } }));
        assert!(target(&off).is_none());
        let on = config(serde_json::json!({ "ssh": { "enabled": true, "host": "b" } }));
        assert!(matches!(target(&on), Some(Target::Ssh(_))));
    }

    #[test]
    fn ssh_command_forwards_to_the_database() {
        let cfg = config(serde_json::json!({
            "host": "db.internal", "port": 0,
            "ssh": { "enabled": true, "host": "bastion", "port": 2222, "user": "ops",
                     "auth": "key", "keyFile": "/k/id_ed25519", "jumpHost": "jump" }
        }));
        let cmd = ssh_command(cfg.ssh_tunnel().unwrap(), &cfg, None, 40000).unwrap();
        let a = args(&cmd);
        assert!(a.contains(&"127.0.0.1:40000:db.internal:5432".to_string()));
        assert!(a.windows(2).any(|w| w == ["-p", "2222"]));
        assert!(a.windows(2).any(|w| w == ["-l", "ops"]));
        assert!(a.windows(2).any(|w| w == ["-J", "jump"]));
        assert!(a.windows(2).any(|w| w == ["-i", "/k/id_ed25519"]));
        // No passphrase: never wait for a prompt
        assert!(a.contains(&"BatchMode=yes".to_string()));
        assert_eq!(a.last().map(String::as_str), Some("bastion"));
    }

    #[test]
    fn ssh_password_goes_through_askpass() {
        let cfg = config(serde_json::json!({
            "ssh": { "enabled": true, "host": "b", "auth": "password" }
        }));
        let ssh = cfg.ssh_tunnel().unwrap();
        assert!(ssh_command(ssh, &cfg, None, 1).is_err());
        let cmd = ssh_command(ssh, &cfg, Some("pw"), 1).unwrap();
        assert!(!args(&cmd).iter().any(|a| a.contains("pw") && a.len() == 2));
        let env: Vec<_> = cmd.as_std().get_envs().collect();
        assert!(
            env.iter()
                .any(|(k, v)| *k == ASKPASS_ENV && v.map(|v| v == "pw").unwrap_or(false))
        );
    }

    #[test]
    fn ssh_rejects_option_injection_and_ipv6_is_bracketed() {
        let cfg = config(serde_json::json!({
            "host": "::1", "ssh": { "enabled": true, "host": "-oProxyCommand=x" }
        }));
        assert!(ssh_command(cfg.ssh_tunnel().unwrap(), &cfg, None, 1).is_err());
        let cfg = config(serde_json::json!({
            "host": "::1", "ssh": { "enabled": true, "host": "b" }
        }));
        let cmd = ssh_command(cfg.ssh_tunnel().unwrap(), &cfg, None, 7).unwrap();
        assert!(args(&cmd).contains(&"127.0.0.1:7:[::1]:5432".to_string()));
    }

    #[tokio::test]
    async fn other_connections_pass_through() {
        let plain = config(serde_json::json!({}));
        let out = prepare("k", plain.clone(), None).await.unwrap();
        assert_eq!((out.host, out.port), (plain.host, plain.port));
        assert!(out.tunneled.is_none());
    }
}
