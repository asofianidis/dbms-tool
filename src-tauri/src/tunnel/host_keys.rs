//! First contact with an SSH server: the tunnel runs `ssh` with
//! StrictHostKeyChecking=yes, so an unknown server fails instead of being
//! trusted silently. This module then fetches the server's key, the user
//! confirms its fingerprint, and the key goes into known_hosts.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::Duration;

use tokio::process::Command;

use super::{destination_options, hide_window, ssh_arg};
use crate::config::SshConfig;
use crate::error::{AppError, AppResult, HostKeyPrompt};

/// What `ssh` prints when StrictHostKeyChecking=yes meets a server key that
/// isn't in known_hosts. A changed key prints something else and must keep
/// failing. The same message comes when known_hosts has the server under
/// another key type only; `probe` tells the two apart (`other_keys_known`).
pub(super) fn is_unknown_host_key(stderr: &str) -> bool {
    stderr.contains("host key is known for") && !stderr.contains("IDENTIFICATION HAS CHANGED")
}

/// A path inside an `ssh -o` value, which ssh splits like a config line
/// (backslashes escape, double quotes group)
fn option_path(path: &Path) -> String {
    format!("\"{}\"", path.to_string_lossy().replace('\\', "/"))
}

/// One line of `ssh-keygen -l`: `256 SHA256:... host (ED25519)`
fn parse_fingerprint(line: &str) -> Option<(String, String)> {
    let mut parts = line.split_whitespace();
    let _bits = parts.next()?;
    let fingerprint = parts.next()?.to_string();
    let key_type = line
        .trim_end()
        .rsplit_once('(')
        .and_then(|(_, t)| t.strip_suffix(')'))?
        .to_string();
    fingerprint
        .starts_with("SHA256:")
        .then_some((fingerprint, key_type))
}

/// The first `userknownhostsfile` in `ssh -G` output: where ssh itself would
/// record a key for that server. The list is space-separated without quoting,
/// so a home folder with a space in it is matched as a whole.
fn known_hosts_path(resolved: &str, home: &Path) -> Option<PathBuf> {
    let value = resolved
        .lines()
        .find_map(|l| l.trim_end().strip_prefix("userknownhostsfile "))?
        .trim_start();
    let home_text = home.to_string_lossy();
    let in_home = |rest: &str| {
        let file = rest.split_whitespace().next().unwrap_or("");
        home.join(file.trim_start_matches(['/', '\\']))
    };
    if let Some(rest) = value.strip_prefix("~/") {
        return Some(in_home(rest));
    }
    if !home_text.is_empty()
        && let Some(rest) = value.strip_prefix(home_text.as_ref())
        && rest.starts_with(['/', '\\'])
    {
        return Some(in_home(rest));
    }
    let file = value.split_whitespace().next()?;
    if file.contains('%') || file.eq_ignore_ascii_case("none") {
        return None;
    }
    Some(PathBuf::from(file))
}

/// How the server is named in the prompt
fn display_host(ssh: &SshConfig) -> String {
    let host = ssh.host.trim();
    let host = match ssh.port {
        0 => host.to_string(),
        p => format!("{host}:{p}"),
    };
    match ssh.jump_host.trim() {
        "" => host,
        jump => format!("{host} (via {jump})"),
    }
}

/// Scanned host keys waiting for the user's answer, by prompt token
static PENDING: LazyLock<parking_lot::Mutex<HashMap<String, Pending>>> =
    LazyLock::new(Default::default);

struct Pending {
    ssh: SshConfig,
    /// known_hosts lines exactly as ssh wrote them
    lines: String,
}

/// Fetches the host key of a server ssh doesn't know, for the user to confirm.
/// Returns the `host_key_unknown` error carrying its fingerprint.
///
/// `ssh-keyscan` can't reach a server behind a jump host or ProxyCommand and
/// doesn't apply ~/.ssh/config (aliases, ports, HostKeyAlias). So `ssh` itself
/// connects with every authentication method turned off, recording the key in
/// a scratch known_hosts file under the name it will look it up by later. It
/// gives up before authenticating, so nothing secret reaches the unverified
/// server. A jump host is checked (and authenticated to) on its own terms, as
/// `ssh -J` always does.
pub(super) async fn probe(ssh: &SshConfig) -> AppError {
    match probe_inner(ssh).await {
        Ok(prompt) => AppError::HostKeyUnknown(Box::new(prompt)),
        Err(e) => e,
    }
}

async fn probe_inner(ssh: &SshConfig) -> AppResult<HostKeyPrompt> {
    let scratch =
        std::env::temp_dir().join(format!("dbms-tool-known-hosts-{}", uuid::Uuid::new_v4()));
    std::fs::write(&scratch, "")?;
    let scanned = scan(ssh, &scratch).await;
    let _ = std::fs::remove_file(&scratch);
    let (lines, fingerprint, key_type) = scanned?;
    let other_key_types_known = other_keys_known(ssh).await;
    let token = uuid::Uuid::new_v4().to_string();
    PENDING.lock().insert(
        token.clone(),
        Pending {
            ssh: ssh.clone(),
            lines,
        },
    );
    Ok(HostKeyPrompt {
        token,
        host: display_host(ssh),
        fingerprint,
        key_type,
        other_key_types_known,
    })
}

/// `ssh -G`: the settings ssh would use for the server, ~/.ssh/config applied.
async fn resolve(ssh: &SshConfig) -> AppResult<Option<String>> {
    let mut cmd = Command::new("ssh");
    cmd.arg("-G");
    destination_options(&mut cmd, ssh)?;
    cmd.arg(ssh_arg(ssh.host.trim(), "server")?)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    hide_window(&mut cmd);
    Ok(cmd
        .output()
        .await
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned()))
}

/// The name a server's keys are recorded under in known_hosts, from `ssh -G`
/// output: its HostKeyAlias or host name, as `[name]:port` off port 22.
fn known_hosts_name(resolved: &str) -> Option<String> {
    let setting = |key: &str| {
        resolved.lines().find_map(|l| {
            l.trim_end()
                .strip_prefix(key)
                .and_then(|v| v.strip_prefix(' '))
                .map(str::to_string)
        })
    };
    let name = setting("hostkeyalias").or_else(|| setting("hostname"))?;
    Some(match setting("port").as_deref() {
        None | Some("22") => name,
        Some(port) => format!("[{name}]:{port}"),
    })
}

/// Whether known_hosts already has keys for the server (of another type than
/// the one it offered, or ssh would have accepted it). That isn't a first
/// contact: the server may have replaced its keys, or be an impostor.
async fn other_keys_known(ssh: &SshConfig) -> bool {
    let Ok(Some(resolved)) = resolve(ssh).await else {
        return false;
    };
    let Some(name) = known_hosts_name(&resolved) else {
        return false;
    };
    let home = std::env::home_dir().unwrap_or_default();
    let mut files: Vec<PathBuf> = known_hosts_path(&resolved, &home).into_iter().collect();
    if let Some(global) = resolved
        .lines()
        .find_map(|l| l.trim_end().strip_prefix("globalknownhostsfile "))
        .and_then(|v| v.split_whitespace().next())
    {
        files.push(PathBuf::from(global));
    }
    for file in files.iter().filter(|f| f.is_file()) {
        let mut keygen = Command::new("ssh-keygen");
        keygen
            .args(["-F", &name, "-f"])
            .arg(file)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        hide_window(&mut keygen);
        // Exits 0 with the matching lines (hashed entries included) when found
        if let Ok(o) = keygen.output().await
            && o.status.success()
            && !o.stdout.trim_ascii().is_empty()
        {
            return true;
        }
    }
    false
}

async fn scan(ssh: &SshConfig, scratch: &Path) -> AppResult<(String, String, String)> {
    let file = option_path(scratch);
    let mut cmd = Command::new("ssh");
    cmd.args(["-N", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15"])
        .args(["-o", "StrictHostKeyChecking=no", "-o", "CheckHostIP=no"])
        .args(["-o", "UpdateHostKeys=no", "-o", "HashKnownHosts=no"])
        .args(["-o", &format!("UserKnownHostsFile={file}")])
        .args(["-o", &format!("GlobalKnownHostsFile={file}")])
        .args([
            "-o",
            "PubkeyAuthentication=no",
            "-o",
            "PasswordAuthentication=no",
        ])
        .args([
            "-o",
            "KbdInteractiveAuthentication=no",
            "-o",
            "GSSAPIAuthentication=no",
        ])
        .args(["-o", "HostbasedAuthentication=no", "-o", "ForwardAgent=no"])
        .args(["-o", "ClearAllForwardings=yes"]);
    destination_options(&mut cmd, ssh)?;
    cmd.arg(ssh_arg(ssh.host.trim(), "server")?)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    hide_window(&mut cmd);
    // A server that lets anyone in without authenticating keeps `-N` open;
    // the key is recorded by then, and dropping the future kills ssh
    let output = tokio::time::timeout(Duration::from_secs(45), cmd.output()).await;
    let lines = std::fs::read_to_string(scratch)?;
    if lines.trim().is_empty() {
        return Err(AppError::msg(match output {
            Ok(Ok(o)) => format!(
                "The SSH server's host key isn't known, and fetching it failed: {}",
                String::from_utf8_lossy(&o.stderr).trim()
            ),
            Ok(Err(e)) => format!("Couldn't run ssh to fetch the host key: {e}"),
            Err(_) => "Timed out fetching the SSH server's host key".to_string(),
        }));
    }

    let mut keygen = Command::new("ssh-keygen");
    keygen
        .args(["-l", "-E", "sha256", "-f"])
        .arg(scratch)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    hide_window(&mut keygen);
    let listed = keygen.output().await.map_err(|e| {
        AppError::msg(format!(
            "Couldn't run ssh-keygen to show the host key's fingerprint: {e}"
        ))
    })?;
    let (fingerprint, key_type) = String::from_utf8_lossy(&listed.stdout)
        .lines()
        .find_map(parse_fingerprint)
        .ok_or_else(|| AppError::msg("Couldn't read the SSH server's host key fingerprint"))?;
    Ok((lines, fingerprint, key_type))
}

/// Adds a host key the user confirmed to the known_hosts file ssh reads for
/// that server; the next connection then checks against it.
pub async fn trust(token: &str) -> AppResult<()> {
    let pending = PENDING
        .lock()
        .remove(token)
        .ok_or_else(|| AppError::msg("That host key confirmation has expired; connect again"))?;
    let home = std::env::home_dir()
        .filter(|h| !h.as_os_str().is_empty())
        .ok_or_else(|| AppError::msg("Couldn't find the home folder for known_hosts"))?;

    let resolved = resolve(&pending.ssh).await?;
    let path = resolved
        .as_deref()
        .and_then(|r| known_hosts_path(r, &home))
        .unwrap_or_else(|| home.join(".ssh").join("known_hosts"));

    if let Some(dir) = path.parent()
        && !dir.exists()
    {
        std::fs::create_dir_all(dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        }
    }
    let existing = std::fs::read(&path).unwrap_or_default();
    let mut text = String::new();
    if !existing.is_empty() && !existing.ends_with(b"\n") {
        text.push('\n');
    }
    for line in pending.lines.lines().filter(|l| !l.trim().is_empty()) {
        text.push_str(line.trim_end());
        text.push('\n');
    }
    use std::io::Write as _;
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| f.write_all(text.as_bytes()))
        .map_err(|e| AppError::msg(format!("Couldn't update {}: {e}", path.display())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tells_unknown_keys_from_changed_ones() {
        assert!(is_unknown_host_key(
            "No ED25519 host key is known for bastion and you have requested strict checking.\r\n\
             Host key verification failed."
        ));
        assert!(!is_unknown_host_key(
            "@@@@@@@@\r\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\r\n\
             Host key verification failed."
        ));
        assert!(!is_unknown_host_key("Permission denied (publickey)."));
    }

    #[test]
    fn reads_ssh_keygen_fingerprints() {
        assert_eq!(
            parse_fingerprint(
                "256 SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8 [db.example.com]:2222 (ED25519)"
            ),
            Some((
                "SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8".to_string(),
                "ED25519".to_string()
            ))
        );
        assert_eq!(
            parse_fingerprint("3072 SHA256:abc bastion (RSA)\r"),
            Some(("SHA256:abc".to_string(), "RSA".to_string()))
        );
        assert_eq!(parse_fingerprint("not a key"), None);
        assert_eq!(parse_fingerprint(""), None);
    }

    #[test]
    fn finds_the_user_known_hosts_file() {
        let home = Path::new("/home/me");
        let resolved = "hostname 10.0.0.5\nport 22\nuserknownhostsfile ~/.ssh/known_hosts ~/.ssh/known_hosts2\n";
        assert_eq!(
            known_hosts_path(resolved, home),
            Some(home.join(".ssh/known_hosts"))
        );
        assert_eq!(
            known_hosts_path("userknownhostsfile /etc/ssh/team_hosts\n", home),
            Some(PathBuf::from("/etc/ssh/team_hosts"))
        );
        assert_eq!(
            known_hosts_path("userknownhostsfile %d/.ssh/x\n", home),
            None
        );
        assert_eq!(known_hosts_path("port 22\n", home), None);
        // Windows OpenSSH prints the home folder expanded, spaces and all
        let spaced = Path::new(r"C:\Users\Jo Smith");
        assert_eq!(
            known_hosts_path(
                "userknownhostsfile C:\\Users\\Jo Smith/.ssh/known_hosts C:\\Users\\Jo Smith/.ssh/known_hosts2\r\n",
                spaced
            ),
            Some(spaced.join(".ssh/known_hosts"))
        );
    }

    #[test]
    fn names_the_server_like_known_hosts() {
        assert_eq!(
            known_hosts_name("hostname 10.0.0.5\nport 22\n").as_deref(),
            Some("10.0.0.5")
        );
        assert_eq!(
            known_hosts_name("hostname db.example.com\r\nport 2222\r\n").as_deref(),
            Some("[db.example.com]:2222")
        );
        assert_eq!(
            known_hosts_name("hostname h\nhostkeyalias bastion\nport 22\n").as_deref(),
            Some("bastion")
        );
        assert_eq!(known_hosts_name("port 22\n"), None);
    }

    #[test]
    fn option_paths_survive_ssh_quoting() {
        assert_eq!(
            option_path(Path::new(r"C:\Users\A B\Temp\kh")),
            "\"C:/Users/A B/Temp/kh\""
        );
    }

    #[test]
    fn prompt_names_port_and_jump_host() {
        let ssh = SshConfig {
            enabled: true,
            host: "bastion".into(),
            port: 2222,
            jump_host: "ops@edge".into(),
            ..Default::default()
        };
        assert_eq!(display_host(&ssh), "bastion:2222 (via ops@edge)");
    }

    #[tokio::test]
    async fn unknown_token_is_rejected() {
        assert!(trust("nope").await.is_err());
    }
}
