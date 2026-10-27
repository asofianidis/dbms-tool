//! Kubernetes tunnels, for databases only a cluster can reach (a private RDS or
//! Cloud SQL endpoint, a Service): a temporary pod relays to the database with
//! socat, and `kubectl port-forward` brings the relay to a local port. Sign-in
//! is whatever kubectl already has.
//!
//! The pod is deleted when its tunnel closes or the app exits. Pods a crashed
//! run left behind are deleted the next time this machine opens a tunnel in the
//! same namespace, and every pod ends itself after `DEADLINE` regardless. Each
//! run holds a lock file while it lives (see `SESSION_LOCK`), so the pods of
//! another copy of the app that is still running are never taken for leftovers.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::process::Command;

use crate::cloud;
use crate::config::{ConnectionConfig, KubeConfig};
use crate::error::{AppError, AppResult};

/// socat on Alpine, pinned by digest
pub const DEFAULT_IMAGE: &str =
    "alpine/socat:1.8.1.3@sha256:603174b77eebaba25ba8f8ebb15e1234d6600409554e95d6fb203fd106150287";

/// What the relay listens on inside the pod (unprivileged, so it can run as nobody)
const RELAY_PORT: u16 = 15432;

/// Long enough to pull the image onto a node
const POD_READY_TIMEOUT: Duration = Duration::from_secs(120);

/// The pod's `activeDeadlineSeconds`: a backstop for pods nothing deleted. A
/// connection open that long loses its tunnel, and `tunnel::ensure` starts a
/// new pod when its sessions reconnect.
const DEADLINE: Duration = Duration::from_secs(12 * 60 * 60);

/// For kubectl calls other than port-forward
const REQUEST_TIMEOUT: &str = "--request-timeout=30s";

const OWNER_LABEL: &str = "dbms-tool/owner";
const SESSION_LABEL: &str = "dbms-tool/session";

/// Names this machine and OS user, so leftover pods are only ever cleaned up by
/// whoever started them
static OWNER: LazyLock<String> = LazyLock::new(|| {
    let user = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_default();
    let host = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|h| !h.is_empty())
        .or_else(|| {
            std::process::Command::new("hostname")
                .output()
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        })
        .unwrap_or_default();
    format!("{:016x}", fnv1a(format!("{user}@{host}").as_bytes()))
});

/// This run of the app
static SESSION: LazyLock<String> = LazyLock::new(|| uuid::Uuid::new_v4().simple().to_string());

/// Locked for as long as this run lives: another run that can lock a session's
/// file knows that session ended, and that its pods are leftovers. Only taken
/// once a tunnel pod starts (see `hold_session_lock`); `None` inside if that failed.
static SESSION_LOCK: OnceLock<Option<std::fs::File>> = OnceLock::new();

fn hold_session_lock() {
    SESSION_LOCK.get_or_init(|| {
        let dir = lock_dir();
        let held = std::fs::create_dir_all(&dir).and_then(|()| {
            let file = std::fs::File::create(lock_path(&dir, &SESSION))?;
            file.lock()?;
            Ok(file)
        });
        held.inspect_err(|e| log::warn!("Couldn't create the tunnel session lock: {e}"))
            .ok()
    });
}

/// Tunnel pods that exist, so they can be deleted on exit (see `shutdown`)
static LIVE: LazyLock<parking_lot::Mutex<HashMap<String, KubeConfig>>> =
    LazyLock::new(Default::default);

fn lock_dir() -> PathBuf {
    std::env::temp_dir().join("dbms-tool-kube-sessions")
}

fn lock_path(dir: &Path, session: &str) -> PathBuf {
    dir.join(format!("{session}.lock"))
}

/// Whether the run that labelled pods with `session` has ended: its lock file
/// is gone or no longer locked.
fn session_ended(dir: &Path, session: &str) -> bool {
    // Only ever a uuid; anything else is no path to open
    if session.is_empty() || !session.chars().all(|c| c.is_ascii_hexdigit()) {
        return false;
    }
    match std::fs::OpenOptions::new()
        .write(true)
        .open(lock_path(dir, session))
    {
        Ok(file) => file.try_lock().is_ok(),
        Err(e) => e.kind() == std::io::ErrorKind::NotFound,
    }
}

/// The pods in a `kubectl get pods -o json` list whose run has ended, and
/// those runs' sessions.
fn leftovers(list: &Value, ended: impl Fn(&str) -> bool) -> (Vec<String>, Vec<String>) {
    let (mut pods, mut sessions) = (Vec::new(), Vec::<String>::new());
    for pod in list["items"].as_array().into_iter().flatten() {
        let (Some(name), Some(session)) = (
            pod["metadata"]["name"].as_str(),
            pod["metadata"]["labels"][SESSION_LABEL].as_str(),
        ) else {
            continue;
        };
        if session != SESSION.as_str() && ended(session) {
            pods.push(name.to_string());
            if !sessions.iter().any(|s| s == session) {
                sessions.push(session.to_string());
            }
        }
    }
    (pods, sessions)
}

/// Deletes the pods that ended runs of the app on this machine left in the
/// namespace. Best effort: listing or deleting may be forbidden where creating
/// isn't.
async fn delete_leftovers(kube: &KubeConfig) {
    let selector = format!("{OWNER_LABEL}={},{SESSION_LABEL}!={}", *OWNER, *SESSION);
    let Ok(json) = run(
        kube,
        &[
            "get",
            "pods",
            "-l",
            &selector,
            "-o",
            "json",
            REQUEST_TIMEOUT,
        ],
        None,
    )
    .await
    else {
        return;
    };
    let Ok(list) = serde_json::from_str::<Value>(&json) else {
        return;
    };
    let dir = lock_dir();
    let (pods, sessions) = leftovers(&list, |s| session_ended(&dir, s));
    if pods.is_empty() {
        return;
    }
    let mut args = vec!["delete", "pod"];
    args.extend(pods.iter().map(String::as_str));
    args.extend(["--wait=false", "--ignore-not-found", REQUEST_TIMEOUT]);
    if run(kube, &args, None).await.is_ok() {
        for session in sessions {
            let _ = std::fs::remove_file(lock_path(&dir, &session));
        }
    }
}

/// Stable across Rust releases, unlike `DefaultHasher`
fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, b| {
        (hash ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3)
    })
}

fn kubectl_path() -> AppResult<PathBuf> {
    cloud::locate_program(&["kubectl"])
        .ok_or_else(|| AppError::msg("Kubernetes tunnels need kubectl, which wasn't found on PATH"))
}

/// kubectl's global flags for the cluster and namespace. The `--flag=value`
/// form keeps a value starting with '-' from being read as another flag.
fn global_args(kube: &KubeConfig) -> Vec<String> {
    let mut args = Vec::new();
    for (flag, value) in [
        ("kubeconfig", &kube.kubeconfig),
        ("context", &kube.context),
        ("namespace", &kube.namespace),
    ] {
        if !value.trim().is_empty() {
            args.push(format!("--{flag}={}", value.trim()));
        }
    }
    args
}

fn command(program: &PathBuf, kube: &KubeConfig) -> Command {
    let mut cmd = Command::new(program);
    cmd.args(global_args(kube))
        .stdin(Stdio::null())
        .kill_on_drop(true);
    // Credential plugins (aws, gke-gcloud-auth-plugin, kubelogin) are found on PATH
    if let Some(path) = cloud::search_path() {
        cmd.env("PATH", path);
    }
    super::hide_window(&mut cmd);
    cmd
}

/// Runs kubectl to completion and returns its stdout.
async fn run(kube: &KubeConfig, args: &[&str], input: Option<&str>) -> AppResult<String> {
    let mut cmd = command(&kubectl_path()?, kube);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    if input.is_some() {
        cmd.stdin(Stdio::piped());
    }
    let mut child = cmd.spawn()?;
    if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
        stdin.write_all(input.as_bytes()).await?;
    }
    let output = tokio::time::timeout(Duration::from_secs(60), child.wait_with_output())
        .await
        .map_err(|_| AppError::msg("kubectl didn't answer within a minute"))??;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(AppError::msg(match stderr.trim() {
        "" => format!("kubectl exited ({})", output.status),
        detail => detail.to_string(),
    }))
}

/// Where the relay connects, as the cluster resolves it.
fn relay_target(config: &ConnectionConfig) -> AppResult<String> {
    let host = config.host.trim();
    if host.is_empty() || host == "localhost" || host == "127.0.0.1" || host == "::1" {
        return Err(AppError::msg(
            "Enter the database host as the cluster sees it (a Service name or private endpoint); localhost would be the tunnel pod itself",
        ));
    }
    // socat reads ',' '!' and ':' as syntax, so only plain names and addresses pass
    if !host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':'))
        || host.starts_with('-')
    {
        return Err(AppError::msg(format!(
            "'{host}' isn't a host name or IP address a tunnel pod can connect to"
        )));
    }
    let port = match config.port {
        0 => super::default_port(config.engine),
        p => p,
    };
    Ok(if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    })
}

fn manifest(name: &str, image: &str, target: &str) -> Value {
    json!({
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {
            "name": name,
            "labels": {
                "app.kubernetes.io/name": "dbms-tool-tunnel",
                "app.kubernetes.io/managed-by": "dbms-tool",
                OWNER_LABEL: *OWNER,
                SESSION_LABEL: *SESSION,
            },
            "annotations": {
                "dbms-tool/target": target,
                // A mesh sidecar would sit between the relay and the database
                "sidecar.istio.io/inject": "false",
                "linkerd.io/inject": "disabled",
            },
        },
        "spec": {
            "restartPolicy": "Never",
            "activeDeadlineSeconds": DEADLINE.as_secs(),
            "terminationGracePeriodSeconds": 1,
            "automountServiceAccountToken": false,
            "enableServiceLinks": false,
            // Meets the "restricted" Pod Security Standard
            "securityContext": {
                "runAsNonRoot": true,
                "runAsUser": 65534,
                "runAsGroup": 65534,
                "seccompProfile": { "type": "RuntimeDefault" },
            },
            "containers": [{
                "name": "relay",
                "image": image,
                "command": ["socat"],
                "args": [
                    format!("TCP-LISTEN:{RELAY_PORT},fork,reuseaddr"),
                    format!("TCP:{target}"),
                ],
                "ports": [{ "containerPort": RELAY_PORT, "protocol": "TCP" }],
                "resources": {
                    "requests": { "cpu": "10m", "memory": "16Mi" },
                    "limits": { "memory": "64Mi" },
                },
                "securityContext": {
                    "allowPrivilegeEscalation": false,
                    "readOnlyRootFilesystem": true,
                    "capabilities": { "drop": ["ALL"] },
                },
            }],
        },
    })
}

#[derive(Debug, PartialEq)]
enum PodState {
    Ready,
    /// Why it isn't ready yet, if the cluster says
    Pending(Option<String>),
    /// It will never be ready
    Failed(String),
}

/// Container waiting reasons a pod doesn't recover from without changes
const FATAL_REASONS: &[&str] = &[
    "ErrImagePull",
    "ImagePullBackOff",
    "InvalidImageName",
    "ErrImageNeverPull",
    "CreateContainerConfigError",
    "CreateContainerError",
    "RunContainerError",
];

fn pod_state(pod: &Value) -> PodState {
    let status = &pod["status"];
    // An injected sidecar may come first
    let container = status["containerStatuses"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|c| c["name"] == "relay")
        .unwrap_or(&Value::Null);
    let detail = |v: &Value| {
        let reason = v["reason"].as_str().unwrap_or_default();
        match v["message"]
            .as_str()
            .map(str::trim)
            .filter(|m| !m.is_empty())
        {
            Some(message) if !reason.is_empty() => format!("{reason}: {message}"),
            Some(message) => message.to_string(),
            None => reason.to_string(),
        }
    };
    if let Some(waiting) = container["state"]["waiting"].as_object()
        && FATAL_REASONS.contains(&waiting.get("reason").and_then(Value::as_str).unwrap_or(""))
    {
        return PodState::Failed(detail(&container["state"]["waiting"]));
    }
    if container["state"]["terminated"].is_object() {
        let why = detail(&container["state"]["terminated"]);
        return PodState::Failed(format!("the relay exited ({why})"));
    }
    match status["phase"].as_str() {
        Some("Failed" | "Succeeded") => return PodState::Failed(detail(status)),
        Some("Running") if container["ready"].as_bool() == Some(true) => return PodState::Ready,
        _ => {}
    }
    let unscheduled = status["conditions"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|c| c["type"] == "PodScheduled" && c["status"] == "False");
    let waiting = container["state"]["waiting"]
        .as_object()
        .map(|_| detail(&container["state"]["waiting"]));
    PodState::Pending(
        unscheduled
            .map(detail)
            .or(waiting)
            .filter(|d| !d.is_empty()),
    )
}

/// A tunnel pod, deleted when dropped.
pub struct Pod {
    pub name: String,
    /// With the context and namespace resolved (see `resolve`)
    kube: KubeConfig,
}

impl Pod {
    fn new(name: String, kube: KubeConfig) -> Self {
        LIVE.lock().insert(name.clone(), kube.clone());
        Self { name, kube }
    }
}

impl Drop for Pod {
    fn drop(&mut self) {
        LIVE.lock().remove(&self.name);
        delete_pod(&self.name, &self.kube);
    }
}

/// Deletes every tunnel pod as the app exits, including any still starting.
pub fn shutdown() {
    for (name, kube) in LIVE.lock().drain() {
        delete_pod(&name, &kube);
    }
    // Never creates the lock: runs that started no tunnel pod have none
    if let Some(Some(_)) = SESSION_LOCK.get() {
        let _ = std::fs::remove_file(lock_path(&lock_dir(), &SESSION));
    }
}

/// Starts `kubectl delete pod` without waiting for it. Synchronous to start, so
/// it still runs when the app is exiting; kubectl outlives the app.
fn delete_pod(name: &str, kube: &KubeConfig) {
    let Ok(program) = kubectl_path() else { return };
    let mut cmd = std::process::Command::new(program);
    cmd.args(global_args(kube))
        .args([
            "delete",
            "pod",
            name,
            "--wait=false",
            "--ignore-not-found",
            REQUEST_TIMEOUT,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(path) = cloud::search_path() {
        cmd.env("PATH", path);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    match cmd.spawn() {
        Ok(mut child) => {
            std::thread::spawn(move || child.wait());
        }
        Err(e) => log::warn!("Couldn't delete tunnel pod {name}: {e}"),
    }
}

/// Pins the context and namespace kubectl would default to, so polling,
/// forwarding and deleting the pod all reach it even if the current context
/// changes meanwhile.
async fn resolve(kube: &KubeConfig) -> AppResult<KubeConfig> {
    let mut kube = kube.clone();
    if kube.context.trim().is_empty() {
        let current = run(&kube, &["config", "current-context"], None)
            .await
            .map_err(|e| AppError::msg(format!("Choose a Kubernetes context: {e}")))?;
        kube.context = current.trim().to_string();
    }
    if kube.namespace.trim().is_empty() {
        let namespace = run(
            &kube,
            &[
                "config",
                "view",
                "--minify",
                "-o",
                "jsonpath={.contexts[0].context.namespace}",
            ],
            None,
        )
        .await?;
        kube.namespace = match namespace.trim() {
            "" => "default".to_string(),
            ns => ns.to_string(),
        };
    }
    Ok(kube)
}

/// Starts a relay pod for `config` and waits until it's running.
pub async fn start_pod(kube: &KubeConfig, config: &ConnectionConfig) -> AppResult<Pod> {
    if config.ssh_tunnel().is_some() {
        return Err(AppError::msg(
            "A connection can use an SSH tunnel or a Kubernetes tunnel pod, not both; turn one off",
        ));
    }
    super::check_forwardable(config, "a Kubernetes tunnel pod")?;
    let target = relay_target(config)?;
    let kube = &resolve(kube).await?;
    // Locked before this run labels a pod, so no other run takes its pods for leftovers
    hold_session_lock();
    delete_leftovers(kube).await;

    let name = format!(
        "dbms-tool-tunnel-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..10]
    );
    let image = match kube.image.trim() {
        "" => DEFAULT_IMAGE,
        i => i,
    };
    let spec = manifest(&name, image, &target).to_string();
    // Deleted from here on if anything fails, including a create that timed
    // out here after the cluster had made the pod
    let pod = Pod::new(name, kube.clone());
    run(kube, &["create", "-f", "-", REQUEST_TIMEOUT], Some(&spec))
        .await
        .map_err(|e| AppError::msg(format!("Couldn't create the tunnel pod: {e}")))?;

    let started = Instant::now();
    let mut last = None;
    loop {
        let json = run(
            kube,
            &["get", "pod", &pod.name, "-o", "json", REQUEST_TIMEOUT],
            None,
        )
        .await?;
        let state = serde_json::from_str::<Value>(&json)
            .map(|v| pod_state(&v))
            .unwrap_or(PodState::Pending(None));
        match state {
            PodState::Ready => return Ok(pod),
            PodState::Failed(why) => {
                return Err(AppError::msg(format!("The tunnel pod didn't start: {why}")));
            }
            PodState::Pending(why) => last = why.or(last),
        }
        if started.elapsed() > POD_READY_TIMEOUT {
            return Err(AppError::msg(match last {
                Some(why) => format!("Timed out waiting for the tunnel pod to start: {why}"),
                None => "Timed out waiting for the tunnel pod to start".to_string(),
            }));
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

/// `kubectl port-forward` from 127.0.0.1:<port> to the relay
pub fn port_forward(pod: &Pod, port: u16) -> AppResult<Command> {
    let mut cmd = command(&kubectl_path()?, &pod.kube);
    cmd.args([
        "port-forward",
        "--address=127.0.0.1",
        &format!("pod/{}", pod.name),
        &format!("{port}:{RELAY_PORT}"),
    ]);
    Ok(cmd)
}

/// What port-forward prints once it holds the local port.
fn forwarding(line: &str, port: u16) -> bool {
    line.starts_with(&format!("Forwarding from 127.0.0.1:{port} "))
}

/// Drains port-forward's stdout and sets `ready` once it holds `port`.
pub async fn watch_stdout(pipe: tokio::process::ChildStdout, port: u16, ready: Arc<AtomicBool>) {
    let mut lines = BufReader::new(pipe).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if forwarding(&line, port) {
            ready.store(true, Ordering::Release);
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Contexts {
    pub contexts: Vec<String>,
    pub current: Option<String>,
}

/// The contexts in the kubeconfig, for the connection dialog.
pub async fn contexts(kubeconfig: &str) -> AppResult<Contexts> {
    let kube = KubeConfig {
        kubeconfig: kubeconfig.to_string(),
        ..Default::default()
    };
    let names = run(&kube, &["config", "get-contexts", "-o", "name"], None).await?;
    // Fails when no context is current
    let current = run(&kube, &["config", "current-context"], None)
        .await
        .ok()
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty());
    Ok(Contexts {
        contexts: names
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(String::from)
            .collect(),
        current,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(extra: Value) -> ConnectionConfig {
        let mut base = json!({ "id": "c", "name": "c", "engine": "postgres", "host": "db.internal", "port": 0 });
        base.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value(base).unwrap()
    }

    #[test]
    fn relay_targets_the_database_as_the_cluster_sees_it() {
        assert_eq!(
            relay_target(&config(json!({}))).unwrap(),
            "db.internal:5432"
        );
        assert_eq!(
            relay_target(&config(json!({ "host": "fd00::5", "port": 6432 }))).unwrap(),
            "[fd00::5]:6432"
        );
        for host in ["", "localhost", "db,fork", "db!!x", "-x", "a b"] {
            assert!(
                relay_target(&config(json!({ "host": host }))).is_err(),
                "{host}"
            );
        }
    }

    #[test]
    fn manifest_runs_socat_as_nobody_and_is_labelled() {
        let m = manifest("p", DEFAULT_IMAGE, "db:5432");
        let c = &m["spec"]["containers"][0];
        assert_eq!(c["command"], json!(["socat"]));
        assert_eq!(c["args"][1], "TCP:db:5432");
        assert_eq!(m["spec"]["securityContext"]["runAsNonRoot"], true);
        assert_eq!(m["spec"]["automountServiceAccountToken"], false);
        assert_eq!(m["metadata"]["labels"][OWNER_LABEL], json!(*OWNER));
        assert!(m["spec"]["activeDeadlineSeconds"].as_u64().unwrap() > 0);
    }

    #[test]
    fn global_flags_keep_values_attached() {
        let kube = KubeConfig {
            context: "-oops".into(),
            namespace: "db".into(),
            ..Default::default()
        };
        assert_eq!(global_args(&kube), ["--context=-oops", "--namespace=db"]);
    }

    #[test]
    fn pod_states() {
        let running = json!({ "status": { "phase": "Running",
            "containerStatuses": [{ "name": "relay", "ready": true, "state": { "running": {} } }] } });
        assert_eq!(pod_state(&running), PodState::Ready);

        let pull = json!({ "status": { "phase": "Pending",
            "containerStatuses": [{ "name": "relay", "ready": false, "state": { "waiting": {
                "reason": "ImagePullBackOff", "message": "Back-off pulling image" } } }] } });
        assert_eq!(
            pod_state(&pull),
            PodState::Failed("ImagePullBackOff: Back-off pulling image".into())
        );

        let creating = json!({ "status": { "phase": "Pending",
            "containerStatuses": [{ "name": "relay", "state": { "waiting": { "reason": "ContainerCreating" } } }] } });
        assert_eq!(
            pod_state(&creating),
            PodState::Pending(Some("ContainerCreating".into()))
        );

        let unscheduled = json!({ "status": { "phase": "Pending", "conditions": [{
            "type": "PodScheduled", "status": "False", "reason": "Unschedulable",
            "message": "0/3 nodes are available" }] } });
        assert_eq!(
            pod_state(&unscheduled),
            PodState::Pending(Some("Unschedulable: 0/3 nodes are available".into()))
        );

        let exited = json!({ "status": { "phase": "Failed", "containerStatuses": [{ "name": "relay",
            "state": { "terminated": { "reason": "Error", "exitCode": 1 } } }] } });
        assert!(matches!(pod_state(&exited), PodState::Failed(_)));

        // An injected sidecar listed first is not the relay
        let sidecar_first = json!({ "status": { "phase": "Running", "containerStatuses": [
            { "name": "istio-proxy", "ready": true, "state": { "running": {} } },
            { "name": "relay", "ready": false, "state": { "terminated": { "reason": "Error" } } }
        ] } });
        assert!(matches!(pod_state(&sidecar_first), PodState::Failed(_)));
        let sidecar_exited = json!({ "status": { "phase": "Running", "containerStatuses": [
            { "name": "sidecar", "state": { "terminated": { "reason": "Completed" } } },
            { "name": "relay", "ready": true, "state": { "running": {} } }
        ] } });
        assert_eq!(pod_state(&sidecar_exited), PodState::Ready);
    }

    #[test]
    fn leftovers_are_pods_of_ended_runs_only() {
        let pod = |name: &str, session: &str| json!({ "metadata": { "name": name, "labels": { SESSION_LABEL: session } } });
        let list = json!({ "items": [
            pod("a", "dead"), pod("b", "dead"), pod("c", "alive"), pod("d", &SESSION),
        ] });
        let (pods, sessions) = leftovers(&list, |s| s != "alive");
        assert_eq!(pods, ["a", "b"]);
        assert_eq!(sessions, ["dead"]);
    }

    #[test]
    fn a_session_ends_when_its_lock_is_released() {
        let dir = std::env::temp_dir().join(format!("dbms-tool-kube-test-{}", *SESSION));
        std::fs::create_dir_all(&dir).unwrap();
        let session = uuid::Uuid::new_v4().simple().to_string();
        let held = std::fs::File::create(lock_path(&dir, &session)).unwrap();
        held.lock().unwrap();
        assert!(!session_ended(&dir, &session));
        drop(held);
        assert!(session_ended(&dir, &session));
        std::fs::remove_file(lock_path(&dir, &session)).unwrap();
        // A crashed run whose lock file is gone too
        assert!(session_ended(&dir, &session));
        // Never a path outside the lock directory
        assert!(!session_ended(&dir, "../x"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ready_once_port_forward_holds_the_port() {
        assert!(forwarding(
            "Forwarding from 127.0.0.1:40000 -> 15432",
            40000
        ));
        assert!(!forwarding(
            "Forwarding from 127.0.0.1:4000 -> 15432",
            40000
        ));
        assert!(!forwarding("Handling connection for 40000", 40000));
    }

    #[test]
    fn owner_is_stable_hex() {
        assert_eq!(OWNER.len(), 16);
        assert_eq!(fnv1a(b"a"), 0xaf63_dc4c_8601_ec8c);
    }
}
