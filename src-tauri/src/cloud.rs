//! Cloud provider CLIs (aws, gcloud, az). The frontend builds the arguments and
//! parses the JSON output; this module only finds the binaries and runs them,
//! so whatever sign-in the user already has (SSO, MFA, profiles) just works.

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
}

impl Provider {
    const ALL: [Provider; 3] = [Provider::Aws, Provider::Gcp, Provider::Azure];

    fn program(self) -> &'static str {
        match self {
            Provider::Aws => "aws",
            Provider::Gcp => "gcloud",
            Provider::Azure => "az",
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
    } else {
        dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/snap/bin"].map(PathBuf::from));
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            dirs.push(home.join("google-cloud-sdk").join("bin"));
            dirs.push(home.join(".local").join("bin"));
        }
    }
    dirs
}

fn locate(provider: Provider) -> Option<PathBuf> {
    let program = provider.program();
    // az and gcloud ship as .cmd wrappers on Windows, which Command won't find on its own
    let names: Vec<String> = if cfg!(windows) {
        ["exe", "cmd", "bat"]
            .iter()
            .map(|ext| format!("{program}.{ext}"))
            .collect()
    } else {
        vec![program.to_string()]
    };
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

/// Runs the provider's CLI and returns its standard output.
pub async fn run(
    provider: Provider,
    args: Vec<String>,
    secret: Option<String>,
    timeout_secs: Option<u64>,
) -> AppResult<String> {
    let program = locate(provider).ok_or_else(|| {
        AppError::msg(format!(
            "The {} CLI isn't installed or isn't on PATH",
            provider.program()
        ))
    })?;
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

    let mut command = Command::new(&program);
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        // Never page, prompt or colour output: there's no terminal to answer
        .env("AWS_PAGER", "")
        .env("AWS_CLI_AUTO_PROMPT", "off")
        .env("CLOUDSDK_CORE_DISABLE_PROMPTS", "1")
        .env("AZURE_CORE_NO_COLOR", "1")
        .env("AZURE_CORE_COLLECT_TELEMETRY", "0");
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

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
            let region = if cloud.region.is_empty() {
                region_from_host(&config.host).ok_or_else(|| {
                    AppError::msg(
                        "Can't tell the AWS region from the host; set it on the connection",
                    )
                })?
            } else {
                &cloud.region
            };
            let port = if config.port == 0 {
                if config.engine == Engine::Mysql {
                    3306
                } else {
                    5432
                }
            } else {
                config.port
            };
            let mut args = owned(&["rds", "generate-db-auth-token", "--hostname", &config.host]);
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
    let key = format!("{:?}|{}", cloud.provider, args.join(" "));
    if let Some((token, at)) = TOKENS.lock().get(&key)
        && at.elapsed() < TOKEN_TTL
    {
        return Ok(token.clone());
    }
    let token = run(cloud.provider, args, None, Some(60))
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

#[cfg(test)]
mod tests {
    use super::*;

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
