//! Backup and restore through each engine's own client tools: pg_dump,
//! pg_restore and psql; mysqldump and mysql; mongodump and mongorestore. The
//! frontend describes a job, this module finds the tool, builds its arguments
//! and streams its output. SQL Server backs up server-side with BACKUP and
//! RESTORE statements, which the frontend runs as ordinary queries.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::Emitter as _;
use tokio::io::{AsyncBufReadExt as _, AsyncRead, AsyncReadExt as _, AsyncWriteExt as _};
use tokio::process::Command;

use crate::config::{ConnectionConfig, Engine, SslMode};
use crate::error::{AppError, AppResult};
use crate::model::CancelSignal;

pub mod builtin;

/// Replaced in arguments by the path of a private temporary file holding the
/// password (a MySQL option file or a MongoDB tools config file), so it never
/// appears in the process list.
const SECRET_TOKEN: &str = "{secret}";

/// Event carrying a running job's output and progress.
pub const PROGRESS_EVENT: &str = "backup-progress";

/// Log lines kept for the failure summary.
const TAIL_LINES: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    PgDump,
    PgRestore,
    Psql,
    Mysqldump,
    Mysql,
    Mongodump,
    Mongorestore,
}

impl ToolKind {
    pub fn for_engine(engine: Engine) -> &'static [ToolKind] {
        match engine {
            Engine::Postgres => &[ToolKind::PgDump, ToolKind::PgRestore, ToolKind::Psql],
            Engine::Mysql => &[ToolKind::Mysqldump, ToolKind::Mysql],
            Engine::Mongo => &[ToolKind::Mongodump, ToolKind::Mongorestore],
            // SQL Server backs up with BACKUP statements; other engines have no tools here
            _ => &[],
        }
    }

    /// Executable names, preferred first (MariaDB renamed its clients).
    fn programs(self) -> &'static [&'static str] {
        match self {
            ToolKind::PgDump => &["pg_dump"],
            ToolKind::PgRestore => &["pg_restore"],
            ToolKind::Psql => &["psql"],
            ToolKind::Mysqldump => &["mysqldump", "mariadb-dump"],
            ToolKind::Mysql => &["mysql", "mariadb"],
            ToolKind::Mongodump => &["mongodump"],
            ToolKind::Mongorestore => &["mongorestore"],
        }
    }

    fn is_postgres(self) -> bool {
        matches!(
            self,
            ToolKind::PgDump | ToolKind::PgRestore | ToolKind::Psql
        )
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub kind: ToolKind,
    /// Resolved executable, `None` when it isn't installed
    pub path: Option<String>,
    /// First line of `--version`
    pub version: Option<String>,
}

impl Tool {
    fn is_mariadb(&self) -> bool {
        self.version
            .as_deref()
            .is_some_and(|v| v.to_ascii_lowercase().contains("mariadb"))
    }

    fn major(&self) -> Option<u32> {
        self.version
            .as_deref()
            .and_then(version_number)
            .map(|v| v.0)
    }
}

/// `(major, minor)` from a `--version` banner or a folder name. mysqldump 5.7
/// reports its protocol version first ("Ver 10.13 Distrib 5.7.44") and MySQL on
/// Windows prints its full path, so `Distrib` and `Ver` narrow the search.
pub fn version_number(banner: &str) -> Option<(u32, u32)> {
    let text = banner
        .split_once("Distrib ")
        .or_else(|| banner.split_once(" Ver "))
        .map_or(banner, |(_, rest)| rest);
    let start = text.find(|c: char| c.is_ascii_digit())?;
    let mut parts = text[start..].split(|c: char| !c.is_ascii_digit());
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    Some((major, minor))
}

/* ---------- Finding tools ---------- */

/// Install locations a GUI app's PATH usually misses; `*` matches one folder level.
fn install_patterns() -> Vec<PathBuf> {
    let mut patterns = Vec::new();
    if cfg!(windows) {
        for var in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(base) = std::env::var_os(var).map(PathBuf::from) {
                for p in [
                    "PostgreSQL/*/bin",
                    "MySQL/*/bin",
                    // MySQL Workbench ships mysqldump next to its executable
                    "MySQL/*",
                    "MariaDB*/bin",
                    "MongoDB/Tools/*/bin",
                    "MongoDB/Server/*/bin",
                ] {
                    patterns.push(base.join(p));
                }
            }
        }
    } else {
        patterns.extend(
            [
                "/opt/homebrew/bin",
                "/usr/local/bin",
                "/opt/homebrew/opt/libpq/bin",
                "/usr/local/opt/libpq/bin",
                "/opt/homebrew/opt/postgresql@*/bin",
                "/usr/local/opt/postgresql@*/bin",
                "/opt/homebrew/opt/mysql-client*/bin",
                "/usr/local/opt/mysql-client*/bin",
                "/Applications/Postgres.app/Contents/Versions/*/bin",
                "/usr/local/mysql/bin",
                "/usr/lib/postgresql/*/bin",
                "/usr/pgsql-*/bin",
                "/snap/bin",
            ]
            .map(PathBuf::from),
        );
    }
    patterns
}

fn wildcard(pattern: &str, name: &str) -> bool {
    let (prefix, suffix) = pattern.split_once('*').unwrap_or((pattern, ""));
    let name = name.to_ascii_lowercase();
    name.len() >= prefix.len() + suffix.len()
        && name.starts_with(&prefix.to_ascii_lowercase())
        && name.ends_with(&suffix.to_ascii_lowercase())
}

/// Expands `*` components of `pattern` against the file system, newest-looking first.
fn expand(pattern: &Path) -> Vec<PathBuf> {
    let mut found = vec![PathBuf::new()];
    for component in pattern.components() {
        let part = component.as_os_str().to_string_lossy();
        if !part.contains('*') {
            for path in &mut found {
                path.push(component);
            }
            continue;
        }
        let mut next = Vec::new();
        for dir in &found {
            let Ok(entries) = std::fs::read_dir(dir) else {
                continue;
            };
            let mut names: Vec<String> = entries
                .flatten()
                .filter(|e| e.path().is_dir())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| wildcard(&part, n))
                .collect();
            names.sort_by_key(|n| std::cmp::Reverse(version_number(n)));
            next.extend(names.into_iter().map(|n| dir.join(n)));
        }
        found = next;
        if found.is_empty() {
            break;
        }
    }
    found
}

fn search_dirs(custom: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(dir) = custom {
        dirs.push(dir.to_path_buf());
        dirs.push(dir.join("bin"));
    }
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    for pattern in install_patterns() {
        dirs.extend(expand(&pattern));
    }
    dirs
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

fn candidates(kind: ToolKind, dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for dir in dirs {
        for name in kind.programs() {
            let file = if cfg!(windows) {
                format!("{name}.exe")
            } else {
                name.to_string()
            };
            let path = dir.join(file);
            // Windows PATH entries often differ only in case
            if is_executable(&path) && seen.insert(path.to_string_lossy().to_lowercase()) {
                out.push(path);
            }
        }
    }
    out
}

fn hide_window(command: &mut Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

async fn banner(path: &Path) -> Option<String> {
    let mut command = Command::new(path);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    hide_window(&mut command);
    let output = tokio::time::timeout(Duration::from_secs(10), command.output())
        .await
        .ok()?
        .ok()?;
    let bytes = if output.stdout.is_empty() {
        &output.stderr
    } else {
        &output.stdout
    };
    String::from_utf8_lossy(bytes)
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_string)
}

/// Finds `kind`, looking in `custom` first. PostgreSQL tools refuse servers newer
/// than themselves, so among several installs the newest wins.
pub async fn resolve(kind: ToolKind, custom: Option<&str>) -> Tool {
    let custom = custom
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .map(PathBuf::from);
    let found = candidates(kind, &search_dirs(custom.as_deref()));
    let in_custom = found
        .first()
        .zip(custom.as_ref())
        .is_some_and(|(p, dir)| p.starts_with(dir));
    let take = if kind.is_postgres() && !in_custom {
        8
    } else {
        1
    };
    let probe: Vec<PathBuf> = found.into_iter().take(take).collect();
    let banners = futures_util::future::join_all(probe.iter().map(|p| banner(p))).await;
    // max_by_key keeps the last maximum; reversing keeps the earliest in search order
    let best = probe
        .into_iter()
        .zip(banners)
        .rev()
        .max_by_key(|(_, b)| b.as_deref().and_then(version_number));
    match best {
        Some((path, version)) => Tool {
            kind,
            path: Some(path.display().to_string()),
            version,
        },
        None => Tool {
            kind,
            path: None,
            version: None,
        },
    }
}

/* ---------- Jobs ---------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Content {
    #[default]
    All,
    Schema,
    Data,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PgFormat {
    Custom,
    Plain,
    Directory,
    Tar,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectName {
    #[serde(default)]
    pub schema: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PgDumpJob {
    pub database: String,
    pub file: String,
    pub format: PgFormat,
    #[serde(default)]
    pub content: Content,
    #[serde(default)]
    pub schemas: Vec<String>,
    #[serde(default)]
    pub tables: Vec<ObjectName>,
    #[serde(default)]
    pub no_owner: bool,
    #[serde(default)]
    pub no_privileges: bool,
    /// Plain format only: DROP … IF EXISTS before each CREATE
    #[serde(default)]
    pub clean: bool,
    /// Plain format only: CREATE DATABASE and connect to it
    #[serde(default)]
    pub create: bool,
    #[serde(default)]
    pub inserts: bool,
    #[serde(default)]
    pub compression: Option<u32>,
    /// Directory format only
    #[serde(default)]
    pub jobs: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PgRestoreJob {
    pub database: String,
    pub file: String,
    #[serde(default)]
    pub content: Content,
    #[serde(default)]
    pub schemas: Vec<String>,
    #[serde(default)]
    pub tables: Vec<ObjectName>,
    #[serde(default)]
    pub clean: bool,
    #[serde(default)]
    pub no_owner: bool,
    #[serde(default)]
    pub no_privileges: bool,
    #[serde(default)]
    pub single_transaction: bool,
    #[serde(default)]
    pub exit_on_error: bool,
    #[serde(default)]
    pub jobs: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PsqlJob {
    pub database: String,
    pub file: String,
    #[serde(default)]
    pub single_transaction: bool,
    #[serde(default)]
    pub stop_on_error: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MysqlDumpJob {
    pub database: String,
    pub file: String,
    #[serde(default)]
    pub content: Content,
    #[serde(default)]
    pub tables: Vec<String>,
    /// Adds CREATE DATABASE and USE (whole-database dumps only)
    #[serde(default)]
    pub create_database: bool,
    #[serde(default)]
    pub routines: bool,
    #[serde(default)]
    pub triggers: bool,
    #[serde(default)]
    pub events: bool,
    #[serde(default)]
    pub drop_tables: bool,
    #[serde(default)]
    pub single_transaction: bool,
    #[serde(default)]
    pub hex_blob: bool,
    #[serde(default)]
    pub extended_insert: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MysqlRestoreJob {
    pub database: String,
    pub file: String,
    /// Keep going after an error
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoDumpJob {
    pub database: String,
    pub path: String,
    /// One archive file rather than a folder of BSON files
    #[serde(default)]
    pub archive: bool,
    #[serde(default)]
    pub gzip: bool,
    #[serde(default)]
    pub exclude_collections: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoRestoreJob {
    pub path: String,
    #[serde(default)]
    pub archive: bool,
    #[serde(default)]
    pub gzip: bool,
    /// `db.collection` names to restore; empty restores everything
    #[serde(default)]
    pub namespaces: Vec<String>,
    /// Restores database `from` in the backup as `to`
    #[serde(default)]
    pub from_database: Option<String>,
    #[serde(default)]
    pub to_database: Option<String>,
    #[serde(default)]
    pub drop: bool,
    #[serde(default)]
    pub stop_on_error: bool,
    #[serde(default)]
    pub no_index_restore: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "tool", rename_all = "snake_case")]
pub enum Job {
    PgDump(PgDumpJob),
    PgRestore(PgRestoreJob),
    Psql(PsqlJob),
    Mysqldump(MysqlDumpJob),
    Mysql(MysqlRestoreJob),
    Mongodump(MongoDumpJob),
    Mongorestore(MongoRestoreJob),
}

/// What to run: arguments, environment, and the files around the process.
#[derive(Debug, Default)]
pub struct Plan {
    pub args: Vec<String>,
    pub env: Vec<(&'static str, String)>,
    /// Written to a private temp file whose path replaces `SECRET_TOKEN`
    pub secret: Option<String>,
    /// Fed to the tool's standard input, with progress by bytes sent
    pub stdin: Option<PathBuf>,
    /// The backup being written, measured when the job ends
    pub output: Option<PathBuf>,
    /// Remove `output` if the job fails or is cancelled (never folders)
    pub discard_on_failure: bool,
}

fn required<'a>(value: &'a str, message: &str) -> AppResult<&'a str> {
    let value = value.trim();
    if value.is_empty() {
        Err(AppError::msg(message))
    } else {
        Ok(value)
    }
}

fn host(cfg: &ConnectionConfig) -> &str {
    match cfg.host.trim() {
        "" => "localhost",
        h => h,
    }
}

fn port(cfg: &ConnectionConfig, default: u16) -> u16 {
    if cfg.port == 0 { default } else { cfg.port }
}

fn pg_connection(plan: &mut Plan, cfg: &ConnectionConfig, password: Option<&str>, db: &str) {
    plan.args.push(format!("--host={}", host(cfg)));
    plan.args.push(format!("--port={}", port(cfg, 5432)));
    if !cfg.user.is_empty() {
        plan.args.push(format!("--username={}", cfg.user));
    }
    // A name with `=` would be read as a connection string
    if db.contains('=') {
        let quoted = db.replace('\\', "\\\\").replace('\'', "\\'");
        plan.args.push(format!("--dbname=dbname='{quoted}'"));
    } else {
        plan.args.push(format!("--dbname={db}"));
    }
    // Never prompt: there's no terminal to answer
    plan.args.push("--no-password".into());
    if let Some(p) = password.filter(|p| !p.is_empty()) {
        plan.env.push(("PGPASSWORD", p.to_string()));
    }
    let ssl = match cfg.ssl {
        SslMode::Disable => "disable",
        SslMode::Prefer => "prefer",
        SslMode::Require => "require",
    };
    plan.env.push(("PGSSLMODE", ssl.into()));
    plan.env.push(("PGCONNECT_TIMEOUT", "15".into()));
    plan.env.push(("PGAPPNAME", "dbms-tool".into()));
}

/// pg_dump pattern matching exactly `name`; double quotes turn off wildcards and case folding.
fn pg_pattern(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Value for a MySQL option file, which understands C-style escapes inside quotes.
fn option_value(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n");
    format!("\"{escaped}\"")
}

fn mysql_connection(plan: &mut Plan, cfg: &ConnectionConfig, password: Option<&str>, tool: &Tool) {
    if let Some(p) = password.filter(|p| !p.is_empty()) {
        // Must come first: the tools only honour option files named before anything else
        plan.args
            .push(format!("--defaults-extra-file={SECRET_TOKEN}"));
        plan.secret = Some(format!("[client]\npassword={}\n", option_value(p)));
    }
    plan.args.push(format!("--host={}", host(cfg)));
    plan.args.push(format!("--port={}", port(cfg, 3306)));
    // "localhost" would otherwise mean the Unix socket, not the port we connect to
    plan.args.push("--protocol=TCP".into());
    if !cfg.user.is_empty() {
        plan.args.push(format!("--user={}", cfg.user));
    }
    let mariadb = tool.is_mariadb();
    let ssl = match (cfg.ssl, mariadb) {
        (SslMode::Disable, false) => Some("--ssl-mode=DISABLED"),
        (SslMode::Prefer, false) => Some("--ssl-mode=PREFERRED"),
        (SslMode::Require, false) => Some("--ssl-mode=REQUIRED"),
        (SslMode::Disable, true) => Some("--skip-ssl"),
        (SslMode::Prefer, true) => None,
        (SslMode::Require, true) => Some("--ssl"),
    };
    plan.args.extend(ssl.map(String::from));
    // MariaDB 11.4+ verifies certificates by default; MySQL's REQUIRED never does
    if mariadb && cfg.ssl != SslMode::Disable && cfg.trust_server_certificate {
        plan.args.push("--skip-ssl-verify-server-cert".into());
    }
}

fn uri_has_password(uri: &str) -> bool {
    let Some((_, rest)) = uri.split_once("://") else {
        return false;
    };
    let authority = rest.split('/').next().unwrap_or(rest);
    authority
        .rsplit_once('@')
        .is_some_and(|(userinfo, _)| userinfo.contains(':'))
}

/// Drops a database named in a MongoDB URI's path, which the tools refuse
/// alongside `--db` and namespace options. That database is also the default
/// authentication database, so it moves to `authSource` (except for SRV URIs,
/// whose DNS records usually name the real one).
pub fn uri_without_database(uri: &str) -> String {
    let Some(scheme_end) = uri.find("://") else {
        return uri.to_string();
    };
    let start = scheme_end + 3;
    let Some(slash) = uri[start..].find('/') else {
        return uri.to_string();
    };
    let base = &uri[..start + slash + 1];
    let after = &uri[start + slash + 1..];
    let (db, query) = match after.split_once('?') {
        Some((d, q)) => (d, q),
        None => (after, ""),
    };
    if db.is_empty() {
        return uri.to_string();
    }
    let mut params: Vec<String> = query
        .split('&')
        .filter(|p| !p.is_empty())
        .map(String::from)
        .collect();
    let has_auth_source = params
        .iter()
        .any(|p| p.to_ascii_lowercase().starts_with("authsource="));
    let srv = uri[..scheme_end].eq_ignore_ascii_case("mongodb+srv");
    let has_credentials = uri[start..start + slash].contains('@');
    if !has_auth_source && !srv && has_credentials {
        params.push(format!("authSource={db}"));
    }
    if params.is_empty() {
        base.to_string()
    } else {
        format!("{base}?{}", params.join("&"))
    }
}

fn mongo_connection(plan: &mut Plan, cfg: &ConnectionConfig, password: Option<&str>) {
    let uri = cfg.uri.trim();
    let password = password.filter(|p| !p.is_empty());
    // JSON strings are valid YAML double-quoted scalars
    let yaml = |s: &str| serde_json::to_string(s).unwrap_or_default();
    let mut config = String::new();
    if uri.is_empty() {
        plan.args.push(format!("--host={}", host(cfg)));
        plan.args.push(format!("--port={}", port(cfg, 27017)));
        if !cfg.user.is_empty() {
            plan.args.push(format!("--username={}", cfg.user));
            let source = if cfg.auth_source.is_empty() {
                "admin"
            } else {
                &cfg.auth_source
            };
            plan.args.push(format!("--authenticationDatabase={source}"));
            if let Some(p) = password {
                config.push_str(&format!("password: {}\n", yaml(p)));
            }
        }
        if cfg.ssl == SslMode::Require {
            plan.args.push("--ssl".into());
            if cfg.trust_server_certificate {
                plan.args.push("--tlsInsecure".into());
            }
        }
    } else {
        config.push_str(&format!("uri: {}\n", yaml(&uri_without_database(uri))));
        if let Some(p) = password
            && !uri_has_password(uri)
        {
            config.push_str(&format!("password: {}\n", yaml(p)));
        }
        let lower = uri.to_ascii_lowercase();
        let tls = lower.starts_with("mongodb+srv:")
            || lower.contains("tls=true")
            || lower.contains("ssl=true");
        if tls && cfg.trust_server_certificate {
            plan.args.push("--tlsInsecure".into());
        }
    }
    if !config.is_empty() {
        plan.args.push(format!("--config={SECRET_TOKEN}"));
        plan.secret = Some(config);
    }
}

/// Escapes a name for mongorestore's namespace patterns, where `*` is a wildcard.
fn ns_escape(name: &str) -> String {
    name.replace('\\', "\\\\").replace('*', "\\*")
}

impl Job {
    pub fn kind(&self) -> ToolKind {
        match self {
            Job::PgDump(_) => ToolKind::PgDump,
            Job::PgRestore(_) => ToolKind::PgRestore,
            Job::Psql(_) => ToolKind::Psql,
            Job::Mysqldump(_) => ToolKind::Mysqldump,
            Job::Mysql(_) => ToolKind::Mysql,
            Job::Mongodump(_) => ToolKind::Mongodump,
            Job::Mongorestore(_) => ToolKind::Mongorestore,
        }
    }

    pub fn is_restore(&self) -> bool {
        matches!(
            self,
            Job::PgRestore(_) | Job::Psql(_) | Job::Mysql(_) | Job::Mongorestore(_)
        )
    }

    pub fn plan(
        &self,
        cfg: &ConnectionConfig,
        password: Option<&str>,
        tool: &Tool,
    ) -> AppResult<Plan> {
        let mut plan = Plan::default();
        let args = |plan: &mut Plan, items: &[&str]| {
            plan.args.extend(items.iter().map(|s| s.to_string()));
        };
        match self {
            Job::PgDump(j) => {
                let db = required(&j.database, "Choose a database to back up")?;
                let file = required(&j.file, "Choose where to save the backup")?;
                pg_connection(&mut plan, cfg, password, db);
                let format = match j.format {
                    PgFormat::Custom => "custom",
                    PgFormat::Plain => "plain",
                    PgFormat::Directory => "directory",
                    PgFormat::Tar => "tar",
                };
                plan.args.push("--verbose".into());
                plan.args.push(format!("--format={format}"));
                match j.content {
                    Content::Schema => args(&mut plan, &["--schema-only"]),
                    Content::Data => args(&mut plan, &["--data-only"]),
                    Content::All => {}
                }
                for schema in &j.schemas {
                    plan.args.push(format!("--schema={}", pg_pattern(schema)));
                }
                for t in &j.tables {
                    let pattern = match &t.schema {
                        Some(s) => format!("{}.{}", pg_pattern(s), pg_pattern(&t.name)),
                        None => pg_pattern(&t.name),
                    };
                    plan.args.push(format!("--table={pattern}"));
                }
                if !j.schemas.is_empty() || !j.tables.is_empty() {
                    // Fail rather than silently dump nothing when a name doesn't match
                    args(&mut plan, &["--strict-names"]);
                }
                if j.no_owner {
                    args(&mut plan, &["--no-owner"]);
                }
                if j.no_privileges {
                    args(&mut plan, &["--no-privileges"]);
                }
                // Archive formats take these at restore time instead
                if j.format == PgFormat::Plain {
                    if j.clean && j.content != Content::Data {
                        args(&mut plan, &["--clean", "--if-exists"]);
                    }
                    if j.create {
                        args(&mut plan, &["--create"]);
                    }
                }
                if j.inserts {
                    args(&mut plan, &["--column-inserts"]);
                }
                if let Some(level) = j.compression
                    && matches!(j.format, PgFormat::Custom | PgFormat::Directory)
                {
                    plan.args.push(format!("--compress={}", level.min(9)));
                }
                if j.format == PgFormat::Directory
                    && let Some(n) = j.jobs.filter(|n| *n > 1)
                {
                    plan.args.push(format!("--jobs={n}"));
                }
                plan.args.push(format!("--file={file}"));
                plan.output = Some(PathBuf::from(file));
                plan.discard_on_failure = j.format != PgFormat::Directory;
            }
            Job::PgRestore(j) => {
                let db = required(&j.database, "Choose a database to restore into")?;
                let file = required(&j.file, "Choose a backup to restore")?;
                pg_connection(&mut plan, cfg, password, db);
                plan.args.push("--verbose".into());
                match j.content {
                    Content::Schema => args(&mut plan, &["--schema-only"]),
                    Content::Data => args(&mut plan, &["--data-only"]),
                    Content::All => {}
                }
                if j.clean && j.content != Content::Data {
                    args(&mut plan, &["--clean", "--if-exists"]);
                }
                if j.no_owner {
                    args(&mut plan, &["--no-owner"]);
                }
                if j.no_privileges {
                    args(&mut plan, &["--no-privileges"]);
                }
                if j.single_transaction {
                    args(&mut plan, &["--single-transaction"]);
                } else if let Some(n) = j.jobs.filter(|n| *n > 1) {
                    plan.args.push(format!("--jobs={n}"));
                }
                if j.exit_on_error {
                    args(&mut plan, &["--exit-on-error"]);
                }
                // pg_restore takes exact names; with tables, -n limits which schemas they come from
                let mut schemas: Vec<&str> = j.schemas.iter().map(String::as_str).collect();
                for t in &j.tables {
                    if let Some(s) = &t.schema
                        && !schemas.contains(&s.as_str())
                    {
                        schemas.push(s);
                    }
                }
                for s in schemas {
                    plan.args.push(format!("--schema={s}"));
                }
                for t in &j.tables {
                    plan.args.push(format!("--table={}", t.name));
                }
                plan.args.push(file.to_string());
            }
            Job::Psql(j) => {
                let db = required(&j.database, "Choose a database to restore into")?;
                let file = required(&j.file, "Choose a backup to restore")?;
                pg_connection(&mut plan, cfg, password, db);
                args(&mut plan, &["--no-psqlrc", "--quiet"]);
                if j.stop_on_error {
                    args(&mut plan, &["--set=ON_ERROR_STOP=1"]);
                }
                if j.single_transaction {
                    args(&mut plan, &["--single-transaction"]);
                }
                args(&mut plan, &["--file=-"]);
                plan.stdin = Some(PathBuf::from(file));
            }
            Job::Mysqldump(j) => {
                let db = required(&j.database, "Choose a database to back up")?;
                let file = required(&j.file, "Choose where to save the backup")?;
                mysql_connection(&mut plan, cfg, password, tool);
                args(
                    &mut plan,
                    &[
                        "--verbose",
                        "--default-character-set=utf8mb4",
                        // Dumping tablespaces needs the PROCESS privilege since 8.0.21
                        "--no-tablespaces",
                    ],
                );
                if j.single_transaction {
                    args(&mut plan, &["--single-transaction"]);
                }
                if j.routines {
                    args(&mut plan, &["--routines"]);
                }
                if j.events {
                    args(&mut plan, &["--events"]);
                }
                if !j.triggers {
                    args(&mut plan, &["--skip-triggers"]);
                }
                match j.content {
                    Content::Schema => args(&mut plan, &["--no-data"]),
                    Content::Data => args(&mut plan, &["--no-create-info"]),
                    Content::All => {}
                }
                if !j.drop_tables {
                    args(&mut plan, &["--skip-add-drop-table"]);
                }
                if j.hex_blob {
                    args(&mut plan, &["--hex-blob"]);
                }
                if !j.extended_insert {
                    args(&mut plan, &["--skip-extended-insert"]);
                }
                if !tool.is_mariadb() {
                    // GTID_PURGED in the dump breaks restoring it onto another server
                    args(&mut plan, &["--set-gtid-purged=OFF"]);
                    // mysqldump 8 queries column statistics older servers and MariaDB lack
                    if tool.major().is_some_and(|m| m >= 8) {
                        args(&mut plan, &["--loose-column-statistics=0"]);
                    }
                }
                plan.args.push(format!("--result-file={file}"));
                if j.create_database && j.tables.is_empty() {
                    args(&mut plan, &["--databases", db]);
                } else {
                    plan.args.push(db.to_string());
                    plan.args.extend(j.tables.iter().cloned());
                }
                plan.output = Some(PathBuf::from(file));
                plan.discard_on_failure = true;
            }
            Job::Mysql(j) => {
                let db = required(&j.database, "Choose a database to restore into")?;
                let file = required(&j.file, "Choose a backup to restore")?;
                mysql_connection(&mut plan, cfg, password, tool);
                args(&mut plan, &["--default-character-set=utf8mb4"]);
                if j.force {
                    args(&mut plan, &["--force"]);
                }
                plan.args.push(db.to_string());
                plan.stdin = Some(PathBuf::from(file));
            }
            Job::Mongodump(j) => {
                let db = required(&j.database, "Choose a database to back up")?;
                let path = required(&j.path, "Choose where to save the backup")?;
                mongo_connection(&mut plan, cfg, password);
                plan.args.push(format!("--db={db}"));
                for c in &j.exclude_collections {
                    plan.args.push(format!("--excludeCollection={c}"));
                }
                if j.gzip {
                    args(&mut plan, &["--gzip"]);
                }
                plan.args.push(if j.archive {
                    format!("--archive={path}")
                } else {
                    format!("--out={path}")
                });
                plan.output = Some(PathBuf::from(path));
                plan.discard_on_failure = j.archive;
            }
            Job::Mongorestore(j) => {
                let path = required(&j.path, "Choose a backup to restore")?;
                mongo_connection(&mut plan, cfg, password);
                if j.drop {
                    args(&mut plan, &["--drop"]);
                }
                if j.stop_on_error {
                    args(&mut plan, &["--stopOnError"]);
                }
                if j.no_index_restore {
                    args(&mut plan, &["--noIndexRestore"]);
                }
                if j.gzip {
                    args(&mut plan, &["--gzip"]);
                }
                for ns in &j.namespaces {
                    let (db, coll) = ns.split_once('.').unwrap_or((ns, ""));
                    plan.args
                        .push(format!("--nsInclude={}.{}", ns_escape(db), ns_escape(coll)));
                }
                let from = j
                    .from_database
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                let to = j
                    .to_database
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                if let (Some(from), Some(to)) = (from, to)
                    && from != to
                {
                    if j.namespaces.is_empty() {
                        plan.args.push(format!("--nsInclude={}.*", ns_escape(from)));
                    }
                    plan.args.push(format!("--nsFrom={}.*", ns_escape(from)));
                    plan.args.push(format!("--nsTo={}.*", ns_escape(to)));
                }
                plan.args.push(if j.archive {
                    format!("--archive={path}")
                } else {
                    format!("--dir={path}")
                });
            }
        }
        Ok(plan)
    }
}

/// The command line as a user would type it, for the review step.
pub fn command_line(tool: &Tool, plan: &Plan) -> String {
    let quote = |s: &str| {
        if !s.is_empty() && !s.contains([' ', '"', '\'', '\t']) {
            s.to_string()
        } else {
            format!("\"{}\"", s.replace('"', "\\\""))
        }
    };
    let program = tool
        .path
        .as_deref()
        .and_then(|p| Path::new(p).file_stem())
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| tool.kind.programs()[0].to_string());
    let mut parts = vec![program];
    parts.extend(
        plan.args
            .iter()
            .map(|a| quote(&a.replace(SECRET_TOKEN, "<password-file>"))),
    );
    if let Some(stdin) = &plan.stdin {
        parts.push(format!("< {}", quote(&stdin.display().to_string())));
    }
    parts.join(" ")
}

/* ---------- Inspecting backups ---------- */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// table | view | materialized_view | sequence | function | procedure | schema | collection | …
    pub kind: String,
    /// Schema (PostgreSQL) or database (MongoDB)
    pub schema: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    /// custom | tar | directory | plain (PostgreSQL), sql (MySQL), archive | dump (MongoDB)
    pub format: String,
    /// Path to restore from; a MongoDB database folder resolves to its dump folder
    pub path: String,
    pub size: u64,
    pub gzip: bool,
    /// Database the backup was taken from, when it records one
    pub database: Option<String>,
    pub source_version: Option<String>,
    pub tool_version: Option<String>,
    /// The backup creates or switches to its own database, whatever the target
    pub creates_database: bool,
    pub entries: Vec<Entry>,
}

async fn read_head(path: &Path, limit: u64) -> AppResult<Vec<u8>> {
    let file = tokio::fs::File::open(path).await?;
    let mut head = Vec::new();
    file.take(limit).read_to_end(&mut head).await?;
    Ok(head)
}

fn size_of(path: &Path) -> u64 {
    let Ok(meta) = std::fs::metadata(path) else {
        return 0;
    };
    if !meta.is_dir() {
        return meta.len();
    }
    std::fs::read_dir(path)
        .map(|entries| entries.flatten().map(|e| size_of(&e.path())).sum())
        .unwrap_or(0)
}

const TOC_KINDS: &[&str] = &[
    "MATERIALIZED VIEW",
    "FOREIGN TABLE",
    "TABLE",
    "VIEW",
    "SEQUENCE",
    "FUNCTION",
    "PROCEDURE",
    "SCHEMA",
    "EXTENSION",
    "TYPE",
    "DOMAIN",
];

/// One object line of `pg_restore --list`: "219; 1259 41081 TABLE sales Orders postgres".
fn parse_toc_entry(line: &str) -> Option<Entry> {
    let (id, rest) = line.split_once(';')?;
    id.trim().parse::<u64>().ok()?;
    let mut fields = rest.trim().splitn(3, ' ');
    fields.next()?;
    fields.next()?;
    let tokens: Vec<&str> = fields.next()?.trim_end().split(' ').collect();
    let kind = TOC_KINDS.iter().find(|k| {
        let words: Vec<&str> = k.split(' ').collect();
        tokens.len() > words.len() && tokens[..words.len()] == words[..]
    })?;
    let rest = &tokens[kind.split(' ').count()..];
    // TABLE DATA, SEQUENCE SET, MATERIALIZED VIEW DATA and the like aren't objects
    if matches!(rest.first(), Some(&("DATA" | "SET" | "OWNED"))) {
        return None;
    }
    let (schema, names) = rest.split_first()?;
    // The owner comes last, except for objects that have none (extensions)
    let name = match names {
        [] => return None,
        [only] => only.to_string(),
        [name @ .., _owner] => name.join(" "),
    };
    Some(Entry {
        kind: kind.to_ascii_lowercase().replace(' ', "_"),
        schema: (*schema != "-").then(|| schema.to_string()),
        name,
    })
}

pub fn parse_pg_list(text: &str, out: &mut Inspection) {
    for line in text.lines() {
        if let Some(header) = line.strip_prefix(';') {
            let header = header.trim();
            let value = |prefix: &str| header.strip_prefix(prefix).map(|v| v.trim().to_string());
            if let Some(v) = value("dbname:") {
                out.database = Some(v);
            } else if let Some(v) = value("Dumped from database version:") {
                out.source_version = Some(v);
            } else if let Some(v) = value("Dumped by pg_dump version:") {
                out.tool_version = Some(v);
            }
        } else if let Some(entry) = parse_toc_entry(line) {
            out.entries.push(entry);
        }
    }
}

fn unquote_ident(token: &str) -> String {
    token
        .trim_end_matches(';')
        .trim_matches(|c| c == '"' || c == '`')
        .to_string()
}

pub fn parse_plain_pg(text: &str, out: &mut Inspection) {
    for line in text.lines().take(80) {
        if let Some(v) = line.strip_prefix("-- Dumped from database version ") {
            out.source_version = Some(v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("-- Dumped by pg_dump version ") {
            out.tool_version = Some(v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("-- Dumped by dbms-tool version ") {
            out.tool_version = Some(format!("dbms-tool {}", v.trim()));
        }
    }
    if let Some(at) = text.find("\nCREATE DATABASE ") {
        out.creates_database = true;
        let name = text[at + 17..].split_whitespace().next().unwrap_or("");
        out.database = Some(unquote_ident(name)).filter(|n| !n.is_empty());
    }
}

pub fn parse_mysql_dump(text: &str, out: &mut Inspection) {
    for line in text.lines().take(60) {
        if let Some(v) = line.strip_prefix("-- ")
            && (v.starts_with("MySQL dump") || v.starts_with("MariaDB dump"))
        {
            out.tool_version = Some(v.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("-- Host:")
            && let Some((_, db)) = rest.split_once("Database:")
        {
            out.database = Some(db.trim().to_string()).filter(|d| !d.is_empty());
        } else if let Some(v) = line.strip_prefix("-- Server version") {
            out.source_version = Some(v.trim().to_string());
        }
    }
    if let Some(at) = text.find("\nUSE `") {
        out.creates_database = true;
        if out.database.is_none() {
            let name = text[at + 5..].split(';').next().unwrap_or("");
            out.database = Some(unquote_ident(name));
        }
    } else if text.contains("\nCREATE DATABASE ") {
        out.creates_database = true;
    }
}

/// Collections in a mongodump folder: `<dump>/<db>/<coll>.bson[.gz]`, or the database folder itself.
fn scan_mongo_dir(path: &Path, out: &mut Inspection) -> AppResult<()> {
    let collections = |dir: &Path| -> Vec<(String, bool)> {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut found: Vec<(String, bool)> = entries
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                if let Some(c) = name.strip_suffix(".bson.gz") {
                    Some((c.to_string(), true))
                } else {
                    name.strip_suffix(".bson").map(|c| (c.to_string(), false))
                }
            })
            .collect();
        found.sort();
        found
    };
    let push = |db: &str, found: Vec<(String, bool)>, out: &mut Inspection| {
        for (name, gz) in found {
            out.gzip |= gz;
            out.entries.push(Entry {
                kind: "collection".into(),
                schema: Some(db.to_string()),
                name,
            });
        }
    };
    let direct = collections(path);
    if !direct.is_empty() {
        let db = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        out.database = Some(db.clone());
        if let Some(parent) = path.parent() {
            out.path = parent.display().to_string();
        }
        push(&db, direct, out);
        return Ok(());
    }
    let mut dbs: Vec<PathBuf> = std::fs::read_dir(path)?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dbs.sort();
    for dir in dbs {
        let db = dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        push(&db, collections(&dir), out);
    }
    if out.entries.is_empty() {
        return Err(AppError::msg(
            "No mongodump output was found in this folder",
        ));
    }
    let dbs: HashSet<&str> = out
        .entries
        .iter()
        .filter_map(|e| e.schema.as_deref())
        .collect();
    if dbs.len() == 1 {
        out.database = dbs.into_iter().next().map(String::from);
    }
    Ok(())
}

/// Namespace from mongorestore's "found collection `db.coll` bson to restore …".
fn found_collection(line: &str) -> Option<(String, String)> {
    let (_, rest) = line.split_once("found collection `")?;
    let (ns, tail) = rest.split_once('`')?;
    if !tail.trim_start().starts_with("bson") {
        return None;
    }
    let (db, coll) = ns.split_once('.')?;
    Some((db.to_string(), coll.to_string()))
}

const GZIP_MAGIC: [u8; 2] = [0x1f, 0x8b];
const MONGO_ARCHIVE_MAGIC: [u8; 4] = [0x6d, 0xe2, 0x99, 0x81];

pub async fn inspect(
    engine: Engine,
    path: &str,
    cfg: &ConnectionConfig,
    password: Option<&str>,
    custom: Option<&str>,
) -> AppResult<Inspection> {
    let p = Path::new(path.trim());
    let meta = tokio::fs::metadata(p)
        .await
        .map_err(|e| AppError::msg(format!("Can't read {}: {e}", p.display())))?;
    let mut out = Inspection {
        path: p.display().to_string(),
        size: size_of(p),
        ..Default::default()
    };
    let compressed = || {
        AppError::msg("Compressed (.gz) SQL files can't be restored directly; decompress it first")
    };
    match engine {
        Engine::Postgres => {
            if meta.is_dir() {
                if !p.join("toc.dat").is_file() {
                    return Err(AppError::msg(
                        "This folder isn't a pg_dump directory backup (it has no toc.dat)",
                    ));
                }
                out.format = "directory".into();
            } else {
                let head = read_head(p, 256 * 1024).await?;
                if head.starts_with(b"PGDMP") {
                    out.format = "custom".into();
                } else if head.get(257..262) == Some(b"ustar") {
                    out.format = "tar".into();
                } else if head.starts_with(&GZIP_MAGIC) {
                    return Err(compressed());
                } else {
                    if head.contains(&0) {
                        return Err(AppError::msg("This file isn't a PostgreSQL backup"));
                    }
                    out.format = "plain".into();
                    parse_plain_pg(&String::from_utf8_lossy(&head), &mut out);
                    return Ok(out);
                }
            }
            let tool = resolve(ToolKind::PgRestore, custom).await;
            if tool.path.is_none() {
                return Err(AppError::msg(format!(
                    "This is a pg_dump {} archive, which needs pg_restore to read and restore. \
                     Install the PostgreSQL client tools, or choose the folder they're in.",
                    out.format
                )));
            }
            let plan = Plan {
                args: vec!["--list".into(), out.path.clone()],
                ..Default::default()
            };
            let (stdout, _) = capture(&tool, plan).await?;
            parse_pg_list(&stdout, &mut out);
        }
        Engine::Mysql => {
            let head = read_head(p, 256 * 1024).await?;
            if head.starts_with(&GZIP_MAGIC) {
                return Err(compressed());
            }
            if meta.is_dir() || head.contains(&0) {
                return Err(AppError::msg("This isn't a SQL file"));
            }
            out.format = "sql".into();
            parse_mysql_dump(&String::from_utf8_lossy(&head), &mut out);
        }
        Engine::Mongo => {
            if meta.is_dir() {
                out.format = "dump".into();
                scan_mongo_dir(p, &mut out)?;
            } else {
                let head = read_head(p, 4).await?;
                out.gzip = head.starts_with(&GZIP_MAGIC);
                if !out.gzip && head != MONGO_ARCHIVE_MAGIC {
                    return Err(AppError::msg("This file isn't a mongodump archive"));
                }
                out.format = "archive".into();
                let tool = resolve(ToolKind::Mongorestore, custom).await;
                if tool.path.is_none() {
                    // The built-in engine reads the archive's own table of contents
                    for (db, name, kind) in builtin::mongo_archive_contents(p)? {
                        out.entries.push(Entry {
                            kind: if kind == "view" {
                                "view".into()
                            } else {
                                "collection".into()
                            },
                            schema: Some(db),
                            name,
                        });
                    }
                    let dbs: HashSet<&str> = out
                        .entries
                        .iter()
                        .filter_map(|e| e.schema.as_deref())
                        .collect();
                    if dbs.len() == 1 {
                        out.database = dbs.into_iter().next().map(String::from);
                    }
                    return Ok(out);
                }
                let mut plan = Plan::default();
                mongo_connection(&mut plan, cfg, password);
                plan.args.extend([
                    format!("--archive={}", out.path),
                    "--dryRun".into(),
                    "--verbose".into(),
                ]);
                if out.gzip {
                    plan.args.push("--gzip".into());
                }
                let (stdout, stderr) = capture(&tool, plan).await?;
                for line in stderr.lines().chain(stdout.lines()) {
                    if let Some((db, name)) = found_collection(line) {
                        out.entries.push(Entry {
                            kind: "collection".into(),
                            schema: Some(db),
                            name,
                        });
                    }
                }
                let dbs: HashSet<&str> = out
                    .entries
                    .iter()
                    .filter_map(|e| e.schema.as_deref())
                    .collect();
                if dbs.len() == 1 {
                    out.database = dbs.into_iter().next().map(String::from);
                }
            }
        }
        _ => {
            return Err(AppError::Unsupported(
                "Backups of this engine aren't read with client tools".into(),
            ));
        }
    }
    Ok(out)
}

/* ---------- Running ---------- */

fn missing_tool(kind: ToolKind) -> AppError {
    AppError::msg(format!(
        "{} wasn't found. Install the database's client tools, or choose the folder they're in.",
        kind.programs()[0]
    ))
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

fn command(tool: &Tool, plan: &Plan, secret: Option<&SecretFile>) -> AppResult<Command> {
    let program = tool.path.as_ref().ok_or_else(|| missing_tool(tool.kind))?;
    let mut command = Command::new(program);
    let secret_path = secret.map(|s| s.0.display().to_string());
    command
        .args(plan.args.iter().map(|a| match &secret_path {
            Some(path) => a.replace(SECRET_TOKEN, path),
            None => a.clone(),
        }))
        .envs(plan.env.iter().map(|(k, v)| (*k, v.as_str())))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    hide_window(&mut command);
    Ok(command)
}

/// Runs a short command (listing an archive) and returns its stdout and stderr.
async fn capture(tool: &Tool, plan: Plan) -> AppResult<(String, String)> {
    let secret = plan.secret.as_deref().map(SecretFile::create).transpose()?;
    let mut command = command(tool, &plan, secret.as_ref())?;
    command.stdin(Stdio::null());
    let output = tokio::time::timeout(Duration::from_secs(120), command.output())
        .await
        .map_err(|_| AppError::msg("Reading the backup timed out"))??;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if !output.status.success() {
        let lines: Vec<String> = stderr.lines().map(String::from).collect();
        return Err(AppError::msg(summarize_failure(
            &lines,
            output.status.code(),
        )));
    }
    Ok((stdout, stderr))
}

/// The useful part of a failed tool's output: its error lines, or the last few lines.
pub fn summarize_failure<S: AsRef<str>>(lines: &[S], code: Option<i32>) -> String {
    let lines: Vec<&str> = lines
        .iter()
        .map(|l| l.as_ref().trim())
        .filter(|l| !l.is_empty())
        .collect();
    let errors: Vec<&str> = lines
        .iter()
        .copied()
        .filter(|l| {
            let lower = l.to_ascii_lowercase();
            lower.contains("error") || lower.contains("fatal") || lower.contains("failed")
        })
        .collect();
    let pick = if errors.is_empty() { &lines } else { &errors };
    let mut tail: Vec<&str> = pick.iter().rev().take(3).copied().collect();
    tail.reverse();
    tail.dedup();
    if tail.is_empty() {
        match code {
            Some(c) => format!("The tool exited with code {c}"),
            None => "The tool was stopped".into(),
        }
    } else {
        tail.join("\n")
    }
}

#[derive(Default)]
struct Log {
    pending: Vec<String>,
    tail: VecDeque<String>,
    errors: u32,
}

impl Log {
    fn push(&mut self, line: String) {
        // psql "ERROR:", mysql "ERROR 1050", mongorestore "Failed:"
        if line.contains("ERROR") || line.starts_with("Failed:") || line.contains("\tFailed:") {
            self.errors += 1;
        }
        if self.tail.len() == TAIL_LINES {
            self.tail.pop_front();
        }
        self.tail.push_back(line.clone());
        self.pending.push(line);
    }
}

async fn pump(reader: impl AsyncRead + Unpin, log: Arc<parking_lot::Mutex<Log>>) {
    let mut reader = tokio::io::BufReader::new(reader);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                // mongo tools redraw progress bars with carriage returns
                for part in String::from_utf8_lossy(&buf).split('\r') {
                    let line = part.trim_end();
                    if !line.is_empty() {
                        log.lock().push(line.to_string());
                    }
                }
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    job: &'a str,
    lines: Vec<String>,
    /// Bytes of the backup fed to the tool so far, for restores read from stdin
    bytes: Option<u64>,
    total: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub cancelled: bool,
    pub elapsed_ms: u64,
    /// Size of the backup written
    pub size: Option<u64>,
    /// Error lines in the output of a run that still exited cleanly
    pub errors: u32,
}

/// Running jobs, so they can be cancelled.
#[derive(Default)]
pub struct Jobs(parking_lot::Mutex<HashMap<String, Arc<CancelSignal>>>);

impl Jobs {
    pub fn cancel(&self, id: &str) {
        if let Some(signal) = self.0.lock().get(id) {
            signal.fire();
        }
    }

    /// Tracks a job run without a client tool (the built-in engine).
    pub(crate) fn register(&self, id: &str) -> Arc<CancelSignal> {
        let signal = Arc::new(CancelSignal::default());
        self.0.lock().insert(id.to_string(), signal.clone());
        signal
    }

    pub(crate) fn unregister(&self, id: &str) {
        self.0.lock().remove(id);
    }
}

pub async fn run(
    app: &tauri::AppHandle,
    jobs: &Jobs,
    job_id: &str,
    tool: &Tool,
    plan: Plan,
) -> AppResult<Outcome> {
    let started = Instant::now();
    let secret = plan.secret.as_deref().map(SecretFile::create).transpose()?;
    let mut command = command(tool, &plan, secret.as_ref())?;
    command.stdin(if plan.stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    let total = match &plan.stdin {
        Some(path) => Some(
            tokio::fs::metadata(path)
                .await
                .map_err(|e| AppError::msg(format!("Can't read {}: {e}", path.display())))?
                .len(),
        ),
        None => None,
    };
    let mut child = command
        .spawn()
        .map_err(|e| AppError::msg(format!("Couldn't start {}: {e}", tool.kind.programs()[0])))?;

    let signal = Arc::new(CancelSignal::default());
    jobs.0.lock().insert(job_id.to_string(), signal.clone());
    let log = Arc::new(parking_lot::Mutex::new(Log::default()));
    let sent = Arc::new(AtomicU64::new(0));
    let mut readers = Vec::new();
    if let Some(out) = child.stdout.take() {
        readers.push(tokio::spawn(pump(out, log.clone())));
    }
    if let Some(err) = child.stderr.take() {
        readers.push(tokio::spawn(pump(err, log.clone())));
    }
    if let (Some(path), Some(mut stdin)) = (plan.stdin.clone(), child.stdin.take()) {
        let sent = sent.clone();
        tokio::spawn(async move {
            let mut file = tokio::fs::File::open(path).await?;
            let mut buf = vec![0u8; 256 * 1024];
            loop {
                let n = file.read(&mut buf).await?;
                if n == 0 {
                    break;
                }
                // Fails once the tool exits early; its own error says why
                stdin.write_all(&buf[..n]).await?;
                sent.fetch_add(n as u64, Ordering::Relaxed);
            }
            stdin.shutdown().await
        });
    }

    let emit = |log: &parking_lot::Mutex<Log>| {
        let lines = std::mem::take(&mut log.lock().pending);
        let bytes = total.map(|_| sent.load(Ordering::Relaxed));
        let _ = app.emit(
            PROGRESS_EVENT,
            Progress {
                job: job_id,
                lines,
                bytes,
                total,
            },
        );
    };
    let mut ticker = tokio::time::interval(Duration::from_millis(250));
    let status = loop {
        tokio::select! {
            status = child.wait() => break Some(status),
            _ = signal.wait() => {
                let _ = child.kill().await;
                break None;
            }
            _ = ticker.tick() => emit(&log),
        }
    };
    for reader in readers {
        let _ = reader.await;
    }
    emit(&log);
    jobs.0.lock().remove(job_id);
    drop(secret);

    let failed = !matches!(&status, Some(Ok(s)) if s.success());
    if failed
        && plan.discard_on_failure
        && let Some(output) = &plan.output
        && output.is_file()
    {
        let _ = std::fs::remove_file(output);
    }
    let elapsed_ms = started.elapsed().as_millis() as u64;
    match status {
        None => Ok(Outcome {
            cancelled: true,
            elapsed_ms,
            size: None,
            errors: 0,
        }),
        Some(Err(e)) => Err(e.into()),
        Some(Ok(s)) if !s.success() => {
            let log = log.lock();
            let tail: Vec<&String> = log.tail.iter().collect();
            Err(AppError::msg(summarize_failure(&tail, s.code())))
        }
        Some(Ok(_)) => Ok(Outcome {
            cancelled: false,
            elapsed_ms,
            size: plan.output.as_deref().map(size_of),
            errors: log.lock().errors,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AuthMode;

    fn cfg(engine: Engine) -> ConnectionConfig {
        ConnectionConfig {
            id: "c".into(),
            name: String::new(),
            engine,
            host: "db.local".into(),
            port: 0,
            user: "admin".into(),
            database: String::new(),
            auth: AuthMode::Password,
            ssl: SslMode::Prefer,
            trust_server_certificate: false,
            uri: String::new(),
            auth_source: String::new(),
            save_password: false,
            read_only: false,
            color: String::new(),
            group: String::new(),
            last_used: None,
            cloud: None,
        }
    }

    fn tool(kind: ToolKind, version: &str) -> Tool {
        Tool {
            kind,
            path: Some(format!("/usr/bin/{}", kind.programs()[0])),
            version: Some(version.into()),
        }
    }

    fn job(json: serde_json::Value) -> Job {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn version_numbers() {
        assert_eq!(version_number("pg_dump (PostgreSQL) 17.11"), Some((17, 11)));
        assert_eq!(
            version_number("mysqldump  Ver 10.13 Distrib 5.7.44, for Linux"),
            Some((5, 7))
        );
        assert_eq!(
            version_number(
                r"C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqldump.exe  Ver 8.4.0 for Win64"
            ),
            Some((8, 4))
        );
        assert_eq!(
            version_number("mongodump version: 100.19.1"),
            Some((100, 19))
        );
        assert_eq!(version_number("postgresql@16"), Some((16, 0)));
        assert_eq!(version_number("no digits"), None);
    }

    #[test]
    fn wildcards() {
        assert!(wildcard("postgresql@*", "postgresql@16"));
        assert!(wildcard("MariaDB*", "MariaDB 11.4"));
        assert!(!wildcard("MariaDB*", "MySQL"));
        assert!(wildcard("*", "anything"));
    }

    #[test]
    fn pg_dump_plan() {
        let j = job(serde_json::json!({
            "tool": "pg_dump", "database": "shop", "file": "/b/shop.dump", "format": "custom",
            "tables": [{"schema": "sales", "name": "Orders"}], "noOwner": true,
            "clean": true, "compression": 6, "jobs": 4
        }));
        let plan = j
            .plan(
                &cfg(Engine::Postgres),
                Some("pw"),
                &tool(ToolKind::PgDump, "pg_dump (PostgreSQL) 17.2"),
            )
            .unwrap();
        assert_eq!(
            plan.args,
            [
                "--host=db.local",
                "--port=5432",
                "--username=admin",
                "--dbname=shop",
                "--no-password",
                "--verbose",
                "--format=custom",
                "--table=\"sales\".\"Orders\"",
                "--strict-names",
                "--no-owner",
                "--compress=6",
                "--file=/b/shop.dump"
            ]
        );
        assert!(plan.env.contains(&("PGPASSWORD", "pw".into())));
        assert!(plan.env.contains(&("PGSSLMODE", "prefer".into())));
        assert!(plan.discard_on_failure);
        assert!(!plan.args.iter().any(|a| a.contains("pw")));
    }

    #[test]
    fn pg_dump_plain_and_directory_options() {
        let plain = job(serde_json::json!({
            "tool": "pg_dump", "database": "a=b", "file": "f.sql", "format": "plain",
            "clean": true, "create": true, "schemas": ["Sales"], "content": "schema"
        }));
        let plan = plain
            .plan(&cfg(Engine::Postgres), None, &tool(ToolKind::PgDump, "17"))
            .unwrap();
        assert!(plan.args.contains(&"--dbname=dbname='a=b'".to_string()));
        for flag in [
            "--clean",
            "--if-exists",
            "--create",
            "--schema-only",
            "--schema=\"Sales\"",
        ] {
            assert!(plan.args.contains(&flag.to_string()), "{flag}");
        }
        assert!(!plan.env.iter().any(|(k, _)| *k == "PGPASSWORD"));

        let dir = job(serde_json::json!({
            "tool": "pg_dump", "database": "shop", "file": "out", "format": "directory", "jobs": 4,
            "clean": true
        }));
        let plan = dir
            .plan(&cfg(Engine::Postgres), None, &tool(ToolKind::PgDump, "17"))
            .unwrap();
        assert!(plan.args.contains(&"--jobs=4".to_string()));
        assert!(!plan.args.contains(&"--clean".to_string()));
        assert!(!plan.discard_on_failure);
    }

    #[test]
    fn pg_restore_plan() {
        let j = job(serde_json::json!({
            "tool": "pg_restore", "database": "copy", "file": "/b/shop.dump", "clean": true,
            "singleTransaction": true, "jobs": 4,
            "tables": [{"schema": "sales", "name": "orders"}, {"schema": "sales", "name": "items"}]
        }));
        let plan = j
            .plan(
                &cfg(Engine::Postgres),
                None,
                &tool(ToolKind::PgRestore, "17"),
            )
            .unwrap();
        let tail: Vec<&str> = plan.args[6..].iter().map(String::as_str).collect();
        assert_eq!(
            tail,
            [
                "--clean",
                "--if-exists",
                "--single-transaction",
                "--schema=sales",
                "--table=orders",
                "--table=items",
                "/b/shop.dump"
            ]
        );
    }

    #[test]
    fn psql_reads_stdin() {
        let j = job(serde_json::json!({
            "tool": "psql", "database": "copy", "file": "/b/shop.sql", "stopOnError": true
        }));
        let plan = j
            .plan(&cfg(Engine::Postgres), None, &tool(ToolKind::Psql, "17"))
            .unwrap();
        assert!(
            plan.args
                .ends_with(&["--set=ON_ERROR_STOP=1".into(), "--file=-".into()])
        );
        assert_eq!(plan.stdin.as_deref(), Some(Path::new("/b/shop.sql")));
    }

    #[test]
    fn mysqldump_plan() {
        let j = job(serde_json::json!({
            "tool": "mysqldump", "database": "shop", "file": "shop.sql", "createDatabase": true,
            "routines": true, "triggers": true, "singleTransaction": true, "dropTables": true,
            "extendedInsert": true
        }));
        let mysql = tool(
            ToolKind::Mysqldump,
            "mysqldump  Ver 8.4.0 for Linux on x86_64",
        );
        let plan = j.plan(&cfg(Engine::Mysql), Some("p\"w"), &mysql).unwrap();
        assert_eq!(plan.args[0], "--defaults-extra-file={secret}");
        assert_eq!(
            plan.secret.as_deref(),
            Some("[client]\npassword=\"p\\\"w\"\n")
        );
        for flag in [
            "--protocol=TCP",
            "--ssl-mode=PREFERRED",
            "--single-transaction",
            "--routines",
            "--set-gtid-purged=OFF",
            "--loose-column-statistics=0",
            "--result-file=shop.sql",
        ] {
            assert!(plan.args.contains(&flag.to_string()), "{flag}");
        }
        assert!(plan.args.ends_with(&["--databases".into(), "shop".into()]));
        assert!(!plan.args.contains(&"--skip-add-drop-table".to_string()));

        let tables = job(serde_json::json!({
            "tool": "mysqldump", "database": "shop", "file": "t.sql", "createDatabase": true,
            "tables": ["orders", "items"], "content": "data"
        }));
        let mariadb = tool(
            ToolKind::Mysqldump,
            "mysqldump from 11.4.2-MariaDB, client 10.19",
        );
        let mut c = cfg(Engine::Mysql);
        c.ssl = SslMode::Require;
        c.trust_server_certificate = true;
        let plan = tables.plan(&c, None, &mariadb).unwrap();
        assert!(
            plan.args
                .ends_with(&["shop".into(), "orders".into(), "items".into()])
        );
        for flag in [
            "--ssl",
            "--skip-ssl-verify-server-cert",
            "--no-create-info",
            "--skip-triggers",
        ] {
            assert!(plan.args.contains(&flag.to_string()), "{flag}");
        }
        assert!(!plan.args.iter().any(|a| a.contains("gtid")));
        assert!(plan.secret.is_none());
    }

    #[test]
    fn mysql_restore_reads_stdin() {
        let j = job(
            serde_json::json!({ "tool": "mysql", "database": "copy", "file": "x.sql", "force": true }),
        );
        let plan = j
            .plan(
                &cfg(Engine::Mysql),
                None,
                &tool(ToolKind::Mysql, "mysql  Ver 8.4.0"),
            )
            .unwrap();
        assert!(plan.args.ends_with(&["--force".into(), "copy".into()]));
        assert!(plan.stdin.is_some());
    }

    #[test]
    fn mongo_plans() {
        let dump = job(serde_json::json!({
            "tool": "mongodump", "database": "shop", "path": "/b/shop.archive", "archive": true,
            "gzip": true, "excludeCollections": ["logs"]
        }));
        let plan = dump
            .plan(
                &cfg(Engine::Mongo),
                Some("pw"),
                &tool(ToolKind::Mongodump, "100"),
            )
            .unwrap();
        assert_eq!(
            plan.args,
            [
                "--host=db.local",
                "--port=27017",
                "--username=admin",
                "--authenticationDatabase=admin",
                "--config={secret}",
                "--db=shop",
                "--excludeCollection=logs",
                "--gzip",
                "--archive=/b/shop.archive"
            ]
        );
        assert_eq!(plan.secret.as_deref(), Some("password: \"pw\"\n"));

        let mut c = cfg(Engine::Mongo);
        c.uri = "mongodb://u:secret@h1,h2/shop?replicaSet=rs".into();
        let restore = job(serde_json::json!({
            "tool": "mongorestore", "path": "/b/dump", "fromDatabase": "shop", "toDatabase": "copy",
            "drop": true
        }));
        let plan = restore
            .plan(&c, Some("ignored"), &tool(ToolKind::Mongorestore, "100"))
            .unwrap();
        assert_eq!(
            plan.secret.as_deref(),
            Some("uri: \"mongodb://u:secret@h1,h2/?replicaSet=rs&authSource=shop\"\n")
        );
        assert_eq!(
            plan.args,
            [
                "--config={secret}",
                "--drop",
                "--nsInclude=shop.*",
                "--nsFrom=shop.*",
                "--nsTo=copy.*",
                "--dir=/b/dump"
            ]
        );
    }

    #[test]
    fn mongo_uris() {
        assert_eq!(uri_without_database("mongodb://h:1/"), "mongodb://h:1/");
        assert_eq!(uri_without_database("mongodb://h/db"), "mongodb://h/");
        assert_eq!(
            uri_without_database("mongodb+srv://u:p@c.x.net/db?retryWrites=true"),
            "mongodb+srv://u:p@c.x.net/?retryWrites=true"
        );
        assert_eq!(
            uri_without_database("mongodb://u:p@h/db?authSource=admin"),
            "mongodb://u:p@h/?authSource=admin"
        );
        assert!(uri_has_password("mongodb://u:p@h/"));
        assert!(!uri_has_password("mongodb://u@h/"));
        assert!(!uri_has_password("mongodb://h/?x=a:b@c"));
    }

    #[test]
    fn command_line_hides_secret() {
        let j =
            job(serde_json::json!({ "tool": "mysql", "database": "copy", "file": "my dump.sql" }));
        let t = tool(ToolKind::Mysql, "mysql  Ver 8.4.0");
        let plan = j.plan(&cfg(Engine::Mysql), Some("pw"), &t).unwrap();
        let line = command_line(&t, &plan);
        assert!(line.starts_with("mysql --defaults-extra-file=<password-file> --host=db.local"));
        assert!(line.ends_with("copy < \"my dump.sql\""));
        assert!(!line.contains("pw"));
    }

    #[test]
    fn pg_list_parsing() {
        let text = ";\n;     dbname: bk\n;     Dumped from database version: 17.11\n;     Dumped by pg_dump version: 17.11\n;\n\
6; 2615 41079 SCHEMA - sales postgres\n\
222; 1255 41096 FUNCTION public add(integer, integer) postgres\n\
220; 1259 41089 TABLE public users postgres\n\
3476; 0 0 SEQUENCE OWNED BY sales Orders_id_seq postgres\n\
221; 1259 41092 VIEW sales v postgres\n\
3469; 0 41089 TABLE DATA public users postgres\n\
3477; 0 0 SEQUENCE SET sales Orders_id_seq postgres\n\
3; 3079 16384 EXTENSION - plpgsql\n";
        let mut out = Inspection::default();
        parse_pg_list(text, &mut out);
        assert_eq!(out.database.as_deref(), Some("bk"));
        assert_eq!(out.source_version.as_deref(), Some("17.11"));
        let got: Vec<(String, Option<String>, String)> = out
            .entries
            .into_iter()
            .map(|e| (e.kind, e.schema, e.name))
            .collect();
        let s = |v: &str| Some(v.to_string());
        assert_eq!(
            got,
            [
                ("schema".into(), None, "sales".into()),
                (
                    "function".into(),
                    s("public"),
                    "add(integer, integer)".into()
                ),
                ("table".into(), s("public"), "users".into()),
                ("view".into(), s("sales"), "v".into()),
                ("extension".into(), None, "plpgsql".into()),
            ]
        );
    }

    #[test]
    fn sql_headers() {
        let mut out = Inspection::default();
        parse_mysql_dump(
            "-- MySQL dump 10.13  Distrib 8.4.0, for Linux (x86_64)\n--\n-- Host: 127.0.0.1    Database: shop\n\
-- Server version\t8.4.0\n\n--\n-- Current Database: `shop`\n--\n\nCREATE DATABASE /*!32312 IF NOT EXISTS*/ `shop`;\n\nUSE `shop`;\n",
            &mut out,
        );
        assert_eq!(out.database.as_deref(), Some("shop"));
        assert_eq!(out.source_version.as_deref(), Some("8.4.0"));
        assert!(
            out.tool_version
                .as_deref()
                .unwrap()
                .starts_with("MySQL dump")
        );
        assert!(out.creates_database);

        let mut out = Inspection::default();
        parse_plain_pg(
            "--\n-- Dumped from database version 17.2\n-- Dumped by pg_dump version 17.2\n\
SET x = 1;\nCREATE DATABASE \"Shop\" WITH TEMPLATE = template0;\n",
            &mut out,
        );
        assert_eq!(out.source_version.as_deref(), Some("17.2"));
        assert!(out.creates_database);
        assert_eq!(out.database.as_deref(), Some("Shop"));
    }

    #[test]
    fn mongo_dryrun_lines() {
        assert_eq!(
            found_collection(
                "2026-10-23T04:28:55.727+0000\tfound collection `bk.users` bson to restore to `bk.users`"
            ),
            Some(("bk".into(), "users".into()))
        );
        assert_eq!(
            found_collection("found collection metadata from `bk.users` to restore to `bk.users`"),
            None
        );
    }

    #[test]
    fn mongo_dump_folders() {
        let root = std::env::temp_dir().join(format!("dbms-mongo-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("shop")).unwrap();
        std::fs::write(root.join("shop").join("orders.bson"), b"").unwrap();
        std::fs::write(root.join("shop").join("orders.metadata.json"), b"").unwrap();
        std::fs::write(root.join("shop").join("users.bson.gz"), b"").unwrap();

        let mut top = Inspection::default();
        scan_mongo_dir(&root, &mut top).unwrap();
        assert_eq!(top.database.as_deref(), Some("shop"));
        assert_eq!(top.entries.len(), 2);
        assert!(top.gzip);

        let mut inner = Inspection::default();
        scan_mongo_dir(&root.join("shop"), &mut inner).unwrap();
        assert_eq!(inner.path, root.display().to_string());
        assert_eq!(inner.entries.len(), 2);

        std::fs::create_dir_all(root.join("empty")).unwrap();
        assert!(scan_mongo_dir(&root.join("empty"), &mut Inspection::default()).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn failure_summaries() {
        let lines = [
            "pg_dump: dumping contents of table x",
            "pg_dump: error: query failed: permission denied",
            "pg_dump: detail: Query was: LOCK TABLE",
        ];
        assert_eq!(
            summarize_failure(&lines, Some(1)),
            "pg_dump: error: query failed: permission denied"
        );
        assert_eq!(summarize_failure(&["a", "b", "c", "d"], Some(2)), "b\nc\nd");
        assert_eq!(
            summarize_failure::<&str>(&[], Some(3)),
            "The tool exited with code 3"
        );
    }

    #[test]
    fn jobs_without_targets_are_rejected() {
        let j = job(
            serde_json::json!({ "tool": "pg_dump", "database": "shop", "file": " ", "format": "plain" }),
        );
        assert!(
            j.plan(&cfg(Engine::Postgres), None, &tool(ToolKind::PgDump, "17"))
                .is_err()
        );
    }
}
