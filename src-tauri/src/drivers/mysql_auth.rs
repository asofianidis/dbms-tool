//! Authentication plugins mysql_async can't sign in with, reported clearly.
//!
//! MariaDB accounts can use ed25519 or parsec. mysql_async 0.37 knows both by name, but
//! builds their responses only behind its `client_ed25519` and `client_parsec` features,
//! which this build leaves off. Without them it panics mid-handshake, and release builds
//! abort on panic, taking the app down. So before connecting with a password, a probe asks
//! MariaDB which client plugin the account starts with, and the connect fails with a
//! message instead. Other plugins the driver lacks (gssapi, pam) already fail with an
//! error, which `connect_error` rewords.
//!
//! The probe sees only the first method. An account with `mysql_native_password OR
//! ed25519` passes it, and a wrong password then falls through to ed25519 and still
//! panics; only the driver features close that.

use std::collections::HashSet;
use std::sync::LazyLock;

use mysql_async::DriverError;
use parking_lot::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::error::{AppError, AppResult};

/// The server plugin behind a client plugin mysql_async would panic on
fn panics_on(client_plugin: &str) -> Option<&'static str> {
    match client_plugin {
        "client_ed25519" => Some("ed25519"),
        "parsec" => Some("parsec"),
        _ => None,
    }
}

const CLIENT_LONG_PASSWORD: u32 = 0x1;
const CLIENT_PROTOCOL_41: u32 = 0x200;
const CLIENT_SECURE_CONNECTION: u32 = 0x8000;
const CLIENT_PLUGIN_AUTH: u32 = 0x8_0000;
/// No server has it, so the server always answers with the plugin the account needs
const PROBE_PLUGIN: &str = "dbms_tool_probe";

#[derive(Debug, PartialEq)]
enum Probe {
    /// MySQL, or a server too old for plugins: nothing the driver panics on
    NotMariaDb,
    /// The client plugin the server switched to
    Plugin(String),
    /// Signed in or refused without a switch
    NoSwitch,
}

/// The greeting's server version and capability flags; None for an error packet
fn parse_greeting(p: &[u8]) -> Option<(&str, u32)> {
    let (&10, rest) = p.split_first()? else {
        return None;
    };
    let nul = rest.iter().position(|&b| b == 0)?;
    let version = std::str::from_utf8(&rest[..nul]).ok()?;
    // Connection id (4), scramble (8) and a filler (1), then the low two bytes of the
    // capabilities; after the charset (1) and status (2) come the high two
    let rest = &rest[nul + 1..];
    let low = u16::from_le_bytes([*rest.get(13)?, *rest.get(14)?]) as u32;
    let high = match (rest.get(18), rest.get(19)) {
        (Some(&a), Some(&b)) => u16::from_le_bytes([a, b]) as u32,
        _ => 0,
    };
    Some((version, low | high << 16))
}

/// HandshakeResponse41 with no auth data and the probe's plugin name
fn handshake_response(user: &str) -> Vec<u8> {
    let caps =
        CLIENT_LONG_PASSWORD | CLIENT_PROTOCOL_41 | CLIENT_SECURE_CONNECTION | CLIENT_PLUGIN_AUTH;
    let mut p = Vec::new();
    p.extend(caps.to_le_bytes());
    p.extend((16u32 << 20).to_le_bytes());
    // utf8mb4_general_ci
    p.push(45);
    p.extend([0; 23]);
    p.extend(user.as_bytes());
    p.push(0);
    p.push(0);
    p.extend(PROBE_PLUGIN.as_bytes());
    p.push(0);
    p
}

/// The plugin an auth switch request names; None for any other packet
fn parse_switch(p: &[u8]) -> Option<String> {
    let (&0xfe, rest) = p.split_first()? else {
        return None;
    };
    let nul = rest.iter().position(|&b| b == 0).unwrap_or(rest.len());
    Some(String::from_utf8_lossy(&rest[..nul]).into_owned())
}

async fn read_packet(s: &mut TcpStream) -> std::io::Result<Vec<u8>> {
    let mut header = [0u8; 4];
    s.read_exact(&mut header).await?;
    let len = u32::from_le_bytes([header[0], header[1], header[2], 0]) as usize;
    let mut payload = vec![0; len];
    s.read_exact(&mut payload).await?;
    Ok(payload)
}

/// Starts a handshake and hangs up at the first auth switch, before any password check,
/// so a probe never counts as a failed sign-in.
async fn probe(host: &str, port: u16, user: &str) -> std::io::Result<Probe> {
    let mut s = TcpStream::connect((host, port)).await?;
    let greeting = read_packet(&mut s).await?;
    let Some((version, caps)) = parse_greeting(&greeting) else {
        return Ok(Probe::NoSwitch);
    };
    if !version.contains("MariaDB") || caps & CLIENT_PLUGIN_AUTH == 0 {
        return Ok(Probe::NotMariaDb);
    }
    let body = handshake_response(user);
    let mut packet = (body.len() as u32).to_le_bytes();
    // Sequence id 1, after the greeting's 0
    packet[3] = 1;
    s.write_all(&packet).await?;
    s.write_all(&body).await?;
    let reply = read_packet(&mut s).await?;
    Ok(parse_switch(&reply).map_or(Probe::NoSwitch, Probe::Plugin))
}

/// Servers already seen to be MySQL, as `host:port`. MariaDB accounts are probed on every
/// connect, since an account can switch to ed25519 while the app runs.
static NOT_MARIADB: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

/// Fails when the account's first sign-in method is one mysql_async would panic on.
/// Probe failures (TLS-only servers, timeouts) are left for the real connect to report.
pub async fn check_account(host: &str, port: u16, user: &str) -> AppResult<()> {
    let server = format!("{host}:{port}");
    if NOT_MARIADB.lock().contains(&server) {
        return Ok(());
    }
    let result = tokio::time::timeout(crate::limits::connect_timeout(), probe(host, port, user));
    match result.await {
        Ok(Ok(Probe::NotMariaDb)) => {
            NOT_MARIADB.lock().insert(server);
        }
        Ok(Ok(Probe::Plugin(name))) => {
            if let Some(plugin) = panics_on(&name) {
                return Err(AppError::msg(unsupported_plugin_message(user, plugin)));
            }
        }
        _ => {}
    }
    Ok(())
}

fn unsupported_plugin_message(user: &str, plugin: &str) -> String {
    format!(
        "MariaDB wants '{user}' to sign in with its {plugin} authentication plugin, which this app \
         can't use yet. If the account uses {plugin}, switch it to mysql_native_password \
         (ALTER USER '{user}'@'<host>' IDENTIFIED VIA mysql_native_password USING \
         PASSWORD('<password>')) or connect as an account that uses mysql_native_password. \
         MariaDB also names a made-up plugin for accounts that don't exist, so check the user \
         name and host too."
    )
}

/// A clearer connect error for sign-in methods the driver doesn't support; None keeps
/// the driver's message.
pub fn connect_error(e: &mysql_async::Error, user: &str) -> Option<String> {
    match e {
        mysql_async::Error::Driver(DriverError::UnknownAuthPlugin { name }) => {
            let plugin = match name.as_str() {
                "auth_gssapi_client" => "gssapi (Kerberos)",
                "dialog" => "pam",
                other => other,
            };
            Some(format!(
                "The account '{user}' signs in with the {plugin} authentication plugin (client \
                 plugin {name}), which this app doesn't support. Use an account with \
                 mysql_native_password or caching_sha2_password."
            ))
        }
        mysql_async::Error::Driver(DriverError::CleartextPluginDisabled) => Some(format!(
            "The account '{user}' needs its password sent in clear text (PAM or LDAP \
             authentication), which this app only does for cloud IAM sign-in. Use an account \
             with mysql_native_password or caching_sha2_password."
        )),
        // ER_ACCESS_DENIED_NO_PASSWORD_ERROR: socket authentication, among others
        mysql_async::Error::Server(s) if s.code == 1698 => Some(format!(
            "ERROR {} ({}): {}. If the account uses unix_socket or auth_socket authentication, it \
             can only sign in over the server's local socket as the matching OS user; this app \
             connects over TCP.",
            s.code,
            s.state,
            s.message.trim_end_matches('.')
        )),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A MariaDB 11.8 greeting, as captured from the server
    fn greeting(version: &str, caps: u32) -> Vec<u8> {
        let mut p = vec![10];
        p.extend(version.as_bytes());
        p.push(0);
        p.extend(7u32.to_le_bytes());
        p.extend(*b"abcdefgh");
        p.push(0);
        p.extend((caps as u16).to_le_bytes());
        p.push(45);
        p.extend(2u16.to_le_bytes());
        p.extend(((caps >> 16) as u16).to_le_bytes());
        p.push(21);
        p.extend([0; 10]);
        p.extend(*b"ijklmnopqrst\0");
        p.extend(*b"mysql_native_password\0");
        p
    }

    #[test]
    fn reads_the_greeting() {
        let caps = 0xf7fe | CLIENT_PLUGIN_AUTH | 0x20_0000;
        let g = greeting("5.5.5-11.8.9-MariaDB-ubu2404", caps);
        assert_eq!(
            parse_greeting(&g),
            Some(("5.5.5-11.8.9-MariaDB-ubu2404", caps))
        );
        // An error packet (host blocked, too many connections)
        assert_eq!(parse_greeting(&[0xff, 0x69, 0x04]), None);
        assert_eq!(parse_greeting(&[10, b'8']), None);
    }

    #[test]
    fn reads_the_switch_request() {
        let mut p = vec![0xfe];
        p.extend(*b"client_ed25519\0");
        p.extend([1; 32]);
        assert_eq!(parse_switch(&p).as_deref(), Some("client_ed25519"));
        assert_eq!(parse_switch(b"\xfeparsec").as_deref(), Some("parsec"));
        assert_eq!(parse_switch(b"\xff\x15\x04#28000Access denied"), None);
        assert_eq!(parse_switch(b"\x00\x00\x00\x02\x00"), None);
    }

    #[test]
    fn writes_an_empty_handshake() {
        let p = handshake_response("app");
        assert_eq!(&p[..4], &0x8_8201u32.to_le_bytes());
        assert_eq!(&p[32..], b"app\0\0dbms_tool_probe\0");
    }

    #[test]
    fn names_the_plugins_that_panic() {
        assert_eq!(panics_on("client_ed25519"), Some("ed25519"));
        assert_eq!(panics_on("parsec"), Some("parsec"));
        assert_eq!(panics_on("mysql_native_password"), None);
        assert_eq!(panics_on("caching_sha2_password"), None);
        let m = unsupported_plugin_message("app", "ed25519");
        assert!(
            m.starts_with("MariaDB wants 'app' to sign in with its ed25519"),
            "{m}"
        );
        assert!(m.contains("IDENTIFIED VIA mysql_native_password"));
    }

    #[test]
    fn rewords_unsupported_plugin_errors() {
        let e = mysql_async::Error::Driver(DriverError::UnknownAuthPlugin {
            name: "auth_gssapi_client".into(),
        });
        let m = connect_error(&e, "app").unwrap();
        assert!(m.contains("gssapi (Kerberos)"), "{m}");
        let e = mysql_async::Error::Driver(DriverError::CleartextPluginDisabled);
        assert!(connect_error(&e, "app").unwrap().contains("clear text"));
        let e = mysql_async::Error::Driver(DriverError::PacketTooLarge);
        assert_eq!(connect_error(&e, "app"), None);
    }
}
