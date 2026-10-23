//! Cloud provider CLIs (aws, gcloud, az). The frontend builds the arguments and
//! parses the JSON output; this module only finds the binaries and runs them,
//! so whatever sign-in the user already has (SSO, MFA, profiles) just works.
//!
//! Every call takes an `account`: empty for the CLI's own sign-in (or the
//! provider's first saved token), otherwise another account the user added. A
//! Google account is one gcloud already holds; for the others it names a saved
//! API token, which the CLIs that accept one get through their environment.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::config::{ConnectionConfig, Engine};
use crate::error::{AppError, AppResult};

/// Replaced in arguments by the path of a temporary file holding the secret, so
/// passwords never appear in the process list.
const SECRET_TOKEN: &str = "{secret}";

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Aws,
    Gcp,
    Azure,
    Railway,
    Render,
    Fly,
    Cloudflare,
}

impl Provider {
    const ALL: [Provider; 7] = [
        Provider::Aws,
        Provider::Gcp,
        Provider::Azure,
        Provider::Railway,
        Provider::Render,
        Provider::Fly,
        Provider::Cloudflare,
    ];

    /// Executable names to look for, first match wins. Render and Cloudflare
    /// are driven through their REST APIs instead.
    fn programs(self) -> &'static [&'static str] {
        match self {
            Provider::Aws => &["aws"],
            Provider::Gcp => &["gcloud"],
            Provider::Azure => &["az"],
            Provider::Railway => &["railway"],
            Provider::Fly => &["flyctl", "fly"],
            Provider::Render | Provider::Cloudflare => &[],
        }
    }

    fn program(self) -> &'static str {
        match self {
            Provider::Render => "render",
            Provider::Cloudflare => "cloudflare",
            _ => self.programs()[0],
        }
    }

    /// The environment variable that signs the CLI in with an API token.
    fn token_env(self) -> Option<&'static str> {
        match self {
            Provider::Fly => Some("FLY_API_TOKEN"),
            Provider::Railway => Some("RAILWAY_API_TOKEN"),
            _ => None,
        }
    }

    /// REST API base URL, for providers driven over HTTP.
    fn api_base(self) -> Option<&'static str> {
        match self {
            Provider::Render => Some("https://api.render.com/v1"),
            Provider::Fly => Some("https://api.machines.dev/v1"),
            Provider::Cloudflare => Some("https://api.cloudflare.com/client/v4"),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudTool {
    pub provider: Provider,
    /// Resolved executable, `None` when the CLI isn't installed
    pub path: Option<String>,
}

pub fn tools() -> Vec<CloudTool> {
    Provider::ALL
        .into_iter()
        .map(|provider| CloudTool {
            provider,
            path: locate(provider).map(|p| p.display().to_string()),
        })
        .collect()
}

/// Directories CLIs are commonly installed to that a GUI app's PATH may miss
/// (macOS apps launched from Finder only see /usr/bin:/bin:/usr/sbin:/sbin).
fn extra_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        for var in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Ok(base) = std::env::var(var) {
                let base = PathBuf::from(base);
                dirs.push(base.join("Amazon").join("AWSCLIV2"));
                dirs.push(
                    base.join("Microsoft SDKs")
                        .join("Azure")
                        .join("CLI2")
                        .join("wbin"),
                );
                dirs.push(
                    base.join("Google")
                        .join("Cloud SDK")
                        .join("google-cloud-sdk")
                        .join("bin"),
                );
            }
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            dirs.push(
                PathBuf::from(local)
                    .join("Google")
                    .join("Cloud SDK")
                    .join("google-cloud-sdk")
                    .join("bin"),
            );
        }
        // npm global installs (railway) and the flyctl installer
        if let Ok(roaming) = std::env::var("APPDATA") {
            dirs.push(PathBuf::from(roaming).join("npm"));
        }
        if let Ok(profile) = std::env::var("USERPROFILE") {
            dirs.push(PathBuf::from(profile).join(".fly").join("bin"));
        }
    } else {
        dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/snap/bin"].map(PathBuf::from));
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            dirs.push(home.join("google-cloud-sdk").join("bin"));
            dirs.push(home.join(".local").join("bin"));
            dirs.push(home.join(".fly").join("bin"));
            dirs.push(home.join(".railway").join("bin"));
        }
    }
    dirs
}

fn locate(provider: Provider) -> Option<PathBuf> {
    // az and gcloud ship as .cmd wrappers on Windows, which Command won't find on its own
    let names: Vec<String> = provider
        .programs()
        .iter()
        .flat_map(|program| {
            if cfg!(windows) {
                ["exe", "cmd", "bat"]
                    .iter()
                    .map(|ext| format!("{program}.{ext}"))
                    .collect::<Vec<_>>()
            } else {
                vec![program.to_string()]
            }
        })
        .collect();
    let path_dirs = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .unwrap_or_default();
    path_dirs
        .into_iter()
        .chain(extra_dirs())
        .flat_map(|dir| names.iter().map(move |n| dir.join(n)))
        .find(|candidate| is_executable(candidate))
}

fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        meta.is_file() && meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        meta.is_file()
    }
}

/// Deletes the secret file however the command ends.
struct SecretFile(PathBuf);

impl SecretFile {
    fn create(contents: &str) -> AppResult<Self> {
        let path = std::env::temp_dir().join(format!("dbms-tool-{}.tmp", uuid::Uuid::new_v4()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let mut file = options.open(&path)?;
        std::io::Write::write_all(&mut file, contents.as_bytes())?;
        Ok(Self(path))
    }
}

impl Drop for SecretFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// A command for the provider's CLI, signed in as `account`, that never pages,
/// prompts or opens a console window. Callers add arguments and stdio.
pub fn command(provider: Provider, account: &str) -> AppResult<Command> {
    let program = locate(provider).ok_or_else(|| {
        AppError::msg(format!(
            "The {} CLI isn't installed or isn't on PATH",
            provider.program()
        ))
    })?;
    let mut command = Command::new(&program);
    command
        .stdin(Stdio::null())
        .kill_on_drop(true)
        // Never page, prompt or colour output: there's no terminal to answer
        .env("AWS_PAGER", "")
        .env("AWS_CLI_AUTO_PROMPT", "off")
        .env("CLOUDSDK_CORE_DISABLE_PROMPTS", "1")
        .env("AZURE_CORE_NO_COLOR", "1")
        .env("AZURE_CORE_COLLECT_TELEMETRY", "0")
        .env("NO_COLOR", "1");
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    if !account.is_empty() {
        if provider == Provider::Gcp {
            // A global flag, so it can go before the command group
            command.arg(format!("--account={account}"));
        } else if let Some(var) = provider.token_env() {
            command.env(var, account_token(provider, account)?);
        }
    }
    Ok(command)
}

/// A folder for CLIs that work on "the current directory" (`railway link`),
/// keyed by what it's for so repeated runs reuse it.
fn workdir(key: &str) -> AppResult<PathBuf> {
    if key.is_empty()
        || !key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::msg("Invalid working directory key"));
    }
    let dir = std::env::temp_dir().join("dbms-tool-cloud").join(key);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Runs the provider's CLI and returns its standard output.
pub async fn run(
    provider: Provider,
    args: Vec<String>,
    secret: Option<String>,
    timeout_secs: Option<u64>,
    workdir_key: Option<&str>,
    account: &str,
) -> AppResult<String> {
    let mut command = command(provider, account)?;
    if let Some(key) = workdir_key {
        command.current_dir(workdir(key)?);
    }
    let secret = secret.as_deref().map(SecretFile::create).transpose()?;
    let args: Vec<String> = match &secret {
        Some(file) => {
            let path = file.0.display().to_string();
            args.into_iter()
                .map(|a| a.replace(SECRET_TOKEN, &path))
                .collect()
        }
        None => args,
    };

    command
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let timeout = timeout_secs.map_or(DEFAULT_TIMEOUT, Duration::from_secs);
    let output = tokio::time::timeout(timeout, command.output())
        .await
        .map_err(|_| {
            AppError::msg(format!(
                "{} timed out after {}s",
                provider.program(),
                timeout.as_secs()
            ))
        })??;
    drop(secret);

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if output.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(AppError::msg(describe_failure(&stderr, &stdout)))
}

/// The command groups the frontend runs, as `(group, subcommands)`; an empty
/// list allows every subcommand. Anything else (`aws configure set`, `az
/// extension add`, `gcloud components`) could change how the CLI signs in or
/// run code, so `cloud_cli` refuses it.
fn allowed_commands(provider: Provider) -> &'static [(&'static str, &'static [&'static str])] {
    match provider {
        Provider::Aws => &[
            ("sso", &["login"]),
            ("sts", &["get-caller-identity"]),
            ("configure", &["list-profiles", "get"]),
            ("secretsmanager", &["get-secret-value"]),
            ("rds", &[]),
            ("docdb", &[]),
            ("ec2", &[]),
        ],
        Provider::Gcp => &[
            ("auth", &["login", "list"]),
            ("config", &["get-value"]),
            ("projects", &["list"]),
            ("sql", &[]),
        ],
        Provider::Azure => &[
            ("login", &[]),
            ("account", &["list", "show"]),
            ("group", &["list", "create"]),
            ("postgres", &[]),
            ("mysql", &[]),
            ("sql", &[]),
            ("cosmosdb", &[]),
        ],
        Provider::Railway => &[
            ("whoami", &[]),
            ("api", &[]),
            ("init", &[]),
            ("link", &[]),
            ("add", &[]),
        ],
        Provider::Fly => &[("auth", &["login", "whoami"]), ("orgs", &[]), ("mpg", &[])],
        Provider::Render | Provider::Cloudflare => &[],
    }
}

/// Checks arguments from the frontend against `allowed_commands`, and rejects
/// flags that point the CLI at another endpoint or turn off TLS checks.
pub fn check_args(provider: Provider, args: &[String]) -> AppResult<()> {
    let refuse = || {
        AppError::msg(format!(
            "dbms-tool doesn't run \"{} {}\"",
            provider.program(),
            args.iter().take(2).cloned().collect::<Vec<_>>().join(" ")
        ))
    };
    let group = args.first().ok_or_else(refuse)?;
    let (_, subcommands) = allowed_commands(provider)
        .iter()
        .find(|(g, _)| g == group)
        .ok_or_else(refuse)?;
    if !subcommands.is_empty()
        && !args
            .get(1)
            .is_some_and(|s| subcommands.contains(&s.as_str()))
    {
        return Err(refuse());
    }
    for arg in args {
        let flag = arg.split('=').next().unwrap_or_default();
        let redirects = matches!(flag, "--endpoint-url" | "--ca-bundle" | "--no-verify-ssl")
            // gcloud reads flags from the secret file the app writes, never another
            || (flag == "--flags-file" && arg != &format!("--flags-file={SECRET_TOKEN}"));
        if redirects {
            return Err(AppError::msg(format!("dbms-tool doesn't pass {flag}")));
        }
    }
    Ok(())
}

/// The useful part of a CLI's error output: drops blank lines, warnings and
/// upgrade nags, keeping the error itself.
fn describe_failure(stderr: &str, stdout: &str) -> String {
    let noise = |line: &str| {
        let l = line.trim().to_ascii_lowercase();
        l.is_empty()
            || l.starts_with("warning:")
            || l.starts_with("updates are available")
            || l.starts_with("to update")
            || l.contains("az upgrade")
    };
    let text = stderr
        .lines()
        .filter(|l| !noise(l))
        .collect::<Vec<_>>()
        .join("\n");
    let text = if text.is_empty() {
        stdout.trim()
    } else {
        text.trim()
    };
    if text.is_empty() {
        "The command failed without an error message".into()
    } else {
        text.to_string()
    }
}

/// The parts of a connection's `cloud` field that token generation needs.
#[derive(Debug, Deserialize)]
struct CloudRef {
    provider: Provider,
    #[serde(default)]
    context: String,
    #[serde(default)]
    region: String,
    #[serde(default)]
    account: String,
}

/// Tokens last 15 minutes (AWS) to an hour (Google, Entra); reuse them for a
/// while so opening tabs doesn't run the CLI every time.
const TOKEN_TTL: Duration = Duration::from_secs(10 * 60);

static TOKENS: LazyLock<parking_lot::Mutex<HashMap<String, (String, Instant)>>> =
    LazyLock::new(Default::default);

/// `mydb.abc123.eu-west-1.rds.amazonaws.com` → `eu-west-1`
fn region_from_host(host: &str) -> Option<&str> {
    let mut labels = host.rsplit('.');
    (labels.next()? == "com" && labels.next()? == "amazonaws" && labels.next()? == "rds")
        .then(|| labels.next())
        .flatten()
}

/// Arguments that print a database login token, and nothing else, to stdout.
fn token_args(config: &ConnectionConfig, cloud: &CloudRef) -> AppResult<Vec<String>> {
    let owned = |args: &[&str]| args.iter().map(|a| a.to_string()).collect::<Vec<_>>();
    Ok(match cloud.provider {
        Provider::Aws => {
            if matches!(config.engine, Engine::Mssql | Engine::Babelfish) {
                return Err(AppError::Unsupported(
                    "AWS IAM authentication works with PostgreSQL and MySQL, not SQL Server".into(),
                ));
            }
            // The token is signed for the database's own address, not a local tunnel's
            let (host, port) = match &config.tunneled {
                Some((host, port)) => (host.as_str(), *port),
                None => (config.host.as_str(), config.port),
            };
            let region = if cloud.region.is_empty() {
                region_from_host(host).ok_or_else(|| {
                    AppError::msg(
                        "Can't tell the AWS region from the host; set it on the connection",
                    )
                })?
            } else {
                &cloud.region
            };
            let port = if port == 0 {
                if config.engine == Engine::Mysql {
                    3306
                } else {
                    5432
                }
            } else {
                port
            };
            let mut args = owned(&["rds", "generate-db-auth-token", "--hostname", host]);
            args.extend(owned(&[
                "--port",
                &port.to_string(),
                "--username",
                &config.user,
            ]));
            args.extend(owned(&["--region", region, "--output", "text"]));
            if !cloud.context.is_empty() {
                args.extend(owned(&["--profile", &cloud.context]));
            }
            args
        }
        Provider::Gcp => owned(&["sql", "generate-login-token", "--quiet"]),
        Provider::Railway | Provider::Render | Provider::Fly | Provider::Cloudflare => {
            return Err(AppError::Unsupported(format!(
                "{} doesn't offer passwordless database sign-in",
                cloud.provider.program()
            )));
        }
        Provider::Azure => {
            // Azure SQL takes a token for the database resource; PostgreSQL and
            // MySQL flexible servers share the "oss-rdbms" resource
            let mut args = if matches!(config.engine, Engine::Mssql | Engine::Babelfish) {
                owned(&[
                    "account",
                    "get-access-token",
                    "--resource",
                    "https://database.windows.net/",
                ])
            } else {
                owned(&[
                    "account",
                    "get-access-token",
                    "--resource-type",
                    "oss-rdbms",
                ])
            };
            args.extend(owned(&["--query", "accessToken", "--output", "tsv"]));
            if !cloud.context.is_empty() {
                args.extend(owned(&["--subscription", &cloud.context]));
            }
            args
        }
    })
}

/// A login token for a connection that uses `AuthMode::Cloud`.
pub async fn database_token(config: &ConnectionConfig) -> AppResult<String> {
    let cloud: CloudRef = config
        .cloud
        .clone()
        .and_then(|v| serde_json::from_value(v).ok())
        .ok_or_else(|| {
            AppError::msg("Pick the cloud provider for IAM sign-in in the connection settings")
        })?;
    let args = token_args(config, &cloud)?;
    let key = format!("{:?}|{}|{}", cloud.provider, cloud.account, args.join(" "));
    if let Some((token, at)) = TOKENS.lock().get(&key)
        && at.elapsed() < TOKEN_TTL
    {
        return Ok(token.clone());
    }
    let token = run(cloud.provider, args, None, Some(60), None, &cloud.account)
        .await?
        .trim()
        .to_string();
    if token.is_empty() {
        return Err(AppError::msg(format!(
            "{} returned an empty token",
            cloud.provider.program()
        )));
    }
    TOKENS.lock().insert(key, (token.clone(), Instant::now()));
    Ok(token)
}

/* ---------- API tokens and REST calls ---------- */

/// The credential store entry for an account's token; the first account keeps
/// the name tokens had before there could be several.
fn token_entry(provider: Provider, account: &str) -> AppResult<keyring::Entry> {
    if !account
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::msg("Invalid account ID"));
    }
    let name = if account.is_empty() {
        format!("cloud-token:{}", provider.program())
    } else {
        format!("cloud-token:{}:{account}", provider.program())
    };
    keyring::Entry::new(crate::config::KEYRING_SERVICE, &name)
        .map_err(|e| AppError::msg(format!("Credential store unavailable: {e}")))
}

/// API token saved for an account: Render and Cloudflare's, or one added for
/// another Fly.io or Railway account.
pub fn stored_token(provider: Provider, account: &str) -> Option<String> {
    token_entry(provider, account).ok()?.get_password().ok()
}

pub fn store_token(provider: Provider, account: &str, token: &str) -> AppResult<()> {
    token_entry(provider, account)?
        .set_password(token.trim())
        .map_err(|e| AppError::msg(format!("Could not save the token: {e}")))
}

pub fn delete_token(provider: Provider, account: &str) {
    if let Ok(entry) = token_entry(provider, account) {
        let _ = entry.delete_credential();
    }
    let prefix = format!("{provider:?}|{account}|");
    TOKENS.lock().retain(|key, _| !key.starts_with(&prefix));
}

fn account_token(provider: Provider, account: &str) -> AppResult<String> {
    stored_token(provider, account).ok_or_else(|| {
        AppError::msg(format!(
            "The token for this {} account is missing; add the account again in the Cloud databases tab",
            provider.program()
        ))
    })
}

static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .user_agent(concat!("dbms-tool/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("HTTP client")
});

/// The bearer token for a REST call: the account's saved API token, or flyctl's
/// own for the account it's signed in to.
pub async fn api_token(provider: Provider, account: &str) -> AppResult<String> {
    if !account.is_empty() {
        return account_token(provider, account);
    }
    if provider == Provider::Fly {
        let key = "Fly||auth token".to_string();
        if let Some((token, at)) = TOKENS.lock().get(&key)
            && at.elapsed() < TOKEN_TTL
        {
            return Ok(token.clone());
        }
        let out = run(
            provider,
            vec!["auth".into(), "token".into()],
            None,
            Some(30),
            None,
            "",
        )
        .await?;
        // Newer flyctl versions print a deprecation note before the token
        let token = out
            .lines()
            .map(str::trim)
            .rfind(|l| !l.is_empty() && !l.contains(' '))
            .unwrap_or_default()
            .to_string();
        if token.is_empty() {
            return Err(AppError::msg(
                "flyctl isn't signed in; run \"fly auth login\"",
            ));
        }
        TOKENS.lock().insert(key, (token.clone(), Instant::now()));
        return Ok(token);
    }
    stored_token(provider, "").ok_or_else(|| {
        AppError::msg(format!(
            "Add a {} API token in the Cloud databases tab first",
            provider.program()
        ))
    })
}

/// The error message out of a provider's JSON error body.
fn api_error(status: reqwest::StatusCode, body: &str) -> String {
    let json: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
    let message = json["errors"][0]["message"]
        .as_str()
        .or_else(|| json["message"].as_str())
        .or_else(|| json["error"].as_str())
        .map(str::to_string)
        .unwrap_or_else(|| body.trim().chars().take(300).collect());
    let reason = status.canonical_reason().unwrap_or("error");
    if message.is_empty() {
        format!("HTTP {} {reason}", status.as_u16())
    } else {
        format!("{message} (HTTP {})", status.as_u16())
    }
}

/// Calls a provider's REST API. `path` is relative to the provider's base
/// URL, so requests (and the token) can only ever go to that provider.
pub async fn api(
    provider: Provider,
    method: &str,
    path: &str,
    body: Option<serde_json::Value>,
    token: Option<&str>,
) -> AppResult<serde_json::Value> {
    let base = provider
        .api_base()
        .ok_or_else(|| AppError::msg(format!("{} has no REST API here", provider.program())))?;
    if !path.starts_with('/') || path.contains("://") || path.contains("..") {
        return Err(AppError::msg("Invalid API path"));
    }
    let method = reqwest::Method::from_bytes(method.to_ascii_uppercase().as_bytes())
        .map_err(|_| AppError::msg("Invalid HTTP method"))?;
    let token = match token {
        Some(t) => t.to_string(),
        None => api_token(provider, "").await?,
    };
    let mut request = HTTP
        .request(method, format!("{base}{path}"))
        .bearer_auth(token)
        .header("Accept", "application/json");
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|e| AppError::msg(format!("Couldn't reach {}: {e}", provider.program())))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| AppError::msg(e.to_string()))?;
    if !status.is_success() {
        return Err(AppError::msg(api_error(status, &text)));
    }
    if text.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }
    Ok(serde_json::from_str(&text)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn cli_allowlist_takes_what_the_frontend_runs() {
        let ok = [
            (
                Provider::Aws,
                &["rds", "describe-db-instances", "--profile", "p"][..],
            ),
            (Provider::Aws, &["configure", "list-profiles"]),
            (
                Provider::Aws,
                &["secretsmanager", "get-secret-value", "--secret-id", "x"],
            ),
            (
                Provider::Gcp,
                &["sql", "instances", "create", "db", "--flags-file={secret}"],
            ),
            (
                Provider::Gcp,
                &["auth", "login", "--brief", "--no-activate"],
            ),
            (Provider::Azure, &["login", "--output", "none"]),
            (Provider::Azure, &["cosmosdb", "keys", "list"]),
            (Provider::Railway, &["api", "query { me { id } }"]),
            (Provider::Fly, &["mpg", "destroy", "abc", "--yes"]),
        ];
        for (provider, args) in ok {
            assert!(check_args(provider, &strings(args)).is_ok(), "{args:?}");
        }
    }

    #[test]
    fn cli_allowlist_refuses_everything_else() {
        let refused = [
            (
                Provider::Aws,
                &["configure", "set", "credential_process", "calc"][..],
            ),
            (Provider::Aws, &["s3", "cp", "s3://b/x", "."]),
            (
                Provider::Aws,
                &["rds", "describe-db-instances", "--endpoint-url=http://evil"],
            ),
            (
                Provider::Aws,
                &["rds", "describe-db-instances", "--no-verify-ssl"],
            ),
            (Provider::Gcp, &["components", "install", "x"]),
            (Provider::Gcp, &["config", "set", "proxy/address", "evil"]),
            (
                Provider::Gcp,
                &["sql", "instances", "list", "--flags-file=/tmp/other"],
            ),
            (
                Provider::Azure,
                &["extension", "add", "--source", "http://evil/x.whl"],
            ),
            (Provider::Fly, &["ssh", "console"]),
            (Provider::Render, &["anything"]),
            (Provider::Aws, &[]),
        ];
        for (provider, args) in refused {
            assert!(check_args(provider, &strings(args)).is_err(), "{args:?}");
        }
    }

    fn connection(engine: Engine, host: &str, cloud: serde_json::Value) -> ConnectionConfig {
        serde_json::from_value(serde_json::json!({
            "id": "x", "name": "x", "engine": engine, "host": host, "port": 0,
            "user": "app_user", "cloud": cloud
        }))
        .unwrap()
    }

    #[test]
    fn aws_token_args_use_host_region_and_profile() {
        let cfg = connection(
            Engine::Postgres,
            "db.abc.eu-west-1.rds.amazonaws.com",
            serde_json::json!({ "provider": "aws", "context": "work" }),
        );
        let cloud: CloudRef = serde_json::from_value(cfg.cloud.clone().unwrap()).unwrap();
        let args = token_args(&cfg, &cloud).unwrap().join(" ");
        assert_eq!(
            args,
            "rds generate-db-auth-token --hostname db.abc.eu-west-1.rds.amazonaws.com --port 5432 --username app_user --region eu-west-1 --output text --profile work"
        );
        let mssql = connection(Engine::Mssql, "x", serde_json::json!({ "provider": "aws" }));
        assert!(token_args(&mssql, &cloud).is_err());
        assert_eq!(region_from_host("example.com"), None);
    }

    #[test]
    fn azure_token_resource_depends_on_engine() {
        let cloud = CloudRef {
            provider: Provider::Azure,
            context: String::new(),
            region: String::new(),
            account: String::new(),
        };
        let sql = token_args(
            &connection(Engine::Mssql, "s", serde_json::Value::Null),
            &cloud,
        );
        assert!(
            sql.unwrap()
                .contains(&"https://database.windows.net/".to_string())
        );
        let pg = token_args(
            &connection(Engine::Postgres, "s", serde_json::Value::Null),
            &cloud,
        );
        assert!(pg.unwrap().contains(&"oss-rdbms".to_string()));
    }

    #[test]
    fn api_errors_read_each_providers_shape() {
        let bad = reqwest::StatusCode::BAD_REQUEST;
        assert_eq!(
            api_error(
                bad,
                r#"{"success":false,"errors":[{"code":7500,"message":"no such table: x"}]}"#
            ),
            "no such table: x (HTTP 400)"
        );
        assert_eq!(
            api_error(bad, r#"{"id":"x","message":"plan is invalid"}"#),
            "plan is invalid (HTTP 400)"
        );
        assert_eq!(
            api_error(bad, r#"{"error":"not found"}"#),
            "not found (HTTP 400)"
        );
        assert_eq!(api_error(bad, ""), "HTTP 400 Bad Request");
    }

    #[tokio::test]
    async fn api_paths_stay_on_the_providers_host() {
        for path in ["https://evil.example/x", "../x", "x"] {
            let err = api(Provider::Render, "GET", path, None, Some("t")).await;
            assert!(err.is_err(), "{path} should be rejected");
        }
        assert!(
            api(Provider::Aws, "GET", "/x", None, Some("t"))
                .await
                .is_err()
        );
    }

    #[test]
    fn account_ids_are_restricted() {
        assert!(token_entry(Provider::Render, "../x").is_err());
        assert!(token_entry(Provider::Render, "a:b").is_err());
    }

    #[test]
    fn workdir_keys_are_restricted() {
        assert!(workdir("railway-abc_1").is_ok());
        assert!(workdir("../etc").is_err());
        assert!(workdir("").is_err());
    }

    #[test]
    fn failure_text_skips_noise() {
        let stderr = "WARNING: something\n\nERROR: (gcloud.sql.instances.list) Permission denied\n";
        assert_eq!(
            describe_failure(stderr, ""),
            "ERROR: (gcloud.sql.instances.list) Permission denied"
        );
        assert_eq!(describe_failure("", " out "), "out");
        assert!(describe_failure("", "").contains("without an error"));
    }

    #[test]
    fn secret_file_is_removed() {
        let file = SecretFile::create("hunter2").unwrap();
        let path = file.0.clone();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "hunter2");
        drop(file);
        assert!(!path.exists());
    }
}
