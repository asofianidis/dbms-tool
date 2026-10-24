//! Tauri command surface. Every command is a thin wrapper around `Manager`.

use tauri::State;

use crate::config::{self, AuthMode, ConnectionConfig, ConnectionStore, Engine};
use crate::drivers::mongo::{MongoOutput, MongoRequest};
use crate::error::{AppError, AppResult};
use crate::manager::{self, Manager};
use crate::model::*;

pub struct AppState {
    pub store: ConnectionStore,
    pub manager: Manager,
    pub backups: crate::backup::Jobs,
}

/// Whether connecting needs a password the user hasn't given us.
fn needs_password(config: &ConnectionConfig) -> bool {
    // SQLite files have no password; D1 falls back to the saved Cloudflare token
    if config.engine == Engine::Sqlite {
        return false;
    }
    if config.engine == Engine::Mongo {
        // A URI may carry its own credentials; only ask when we built it ourselves
        return config.uri.trim().is_empty() && !config.user.is_empty();
    }
    // Cloud tokens are fetched at connect time, and Windows auth needs none
    config.auth == AuthMode::Password && !config.user.is_empty()
}

/// `"name" [engine user@host:port]`, for log lines. Never includes secrets.
fn describe(config: &ConnectionConfig) -> String {
    let mut target = format!("{:?}", config.engine).to_lowercase();
    if !config.host.is_empty() {
        target.push(' ');
        if !config.user.is_empty() {
            target.push_str(&config.user);
            target.push('@');
        }
        target.push_str(&config.host);
        if config.port != 0 {
            target.push_str(&format!(":{}", config.port));
        }
    }
    format!("\"{}\" [{target}]", config.name)
}

fn connection_label(state: &AppState, id: &str) -> String {
    state
        .store
        .get(id)
        .map(|c| describe(&c))
        .unwrap_or_else(|_| format!("connection {id}"))
}

/// Logs a failed command. A missing password is a prompt, not a failure.
fn logged<T>(result: AppResult<T>, context: impl FnOnce() -> String) -> AppResult<T> {
    if let Err(e) = &result
        && !matches!(e, AppError::PasswordRequired)
    {
        log::error!("{}: {e}", context());
    }
    result
}

/// Blanks out quoted strings, so passwords (`IDENTIFIED BY '…'`) and data
/// values never reach the log file. A doubled quote inside a string stays inside it.
fn redact_literals(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut quote: Option<char> = None;
    let mut chars = sql.chars().peekable();
    while let Some(c) = chars.next() {
        match quote {
            None => {
                out.push(c);
                if c == '\'' || c == '"' {
                    quote = Some(c);
                    out.push('…');
                }
            }
            // MySQL's \' escape; elsewhere this can only hide more, never less
            Some(_) if c == '\\' => {
                chars.next();
            }
            Some(q) if c == q && chars.peek() == Some(&q) => {
                chars.next();
            }
            Some(q) if c == q => {
                out.push(c);
                quote = None;
            }
            Some(_) => {}
        }
    }
    out
}

/// The start of a statement on one line, so log entries stay readable.
fn snippet(sql: &str) -> String {
    const MAX: usize = 200;
    let sql = redact_literals(sql);
    let flat = sql.split_whitespace().collect::<Vec<_>>().join(" ");
    match flat.char_indices().nth(MAX) {
        Some((i, _)) => format!("{}...", &flat[..i]),
        None => flat,
    }
}

fn resolve_password(config: &ConnectionConfig, given: Option<String>) -> Option<String> {
    given.or_else(|| {
        (config.save_password && !config.id.is_empty())
            .then(|| config::load_password(&config.id))
            .flatten()
    })
}

#[tauri::command]
pub fn connections_list(state: State<'_, AppState>) -> Vec<ConnectionConfig> {
    state.store.list()
}

#[tauri::command]
pub fn connection_save(
    state: State<'_, AppState>,
    config: ConnectionConfig,
    password: Option<String>,
    ssh_secret: Option<String>,
) -> AppResult<ConnectionConfig> {
    let saved = state.store.upsert(config)?;
    if saved.save_password {
        if let Some(p) = password {
            config::store_password(&saved.id, &p)?;
        }
    } else {
        config::delete_password(&saved.id);
    }
    // Tunnels reconnect on their own, so an SSH password or passphrase is always saved
    let ssh_id = config::ssh_secret_id(&saved.id);
    match (&saved.ssh, ssh_secret.filter(|s| !s.is_empty())) {
        (None, _) => config::delete_password(&ssh_id),
        (Some(ssh), _) if ssh.auth == config::SshAuth::Agent => config::delete_password(&ssh_id),
        (Some(_), Some(secret)) => config::store_password(&ssh_id, &secret)?,
        (Some(_), None) => {}
    }
    Ok(saved)
}

#[tauri::command]
pub fn connection_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.manager.close(&id);
    config::delete_password(&id);
    config::delete_password(&config::ssh_secret_id(&id));
    state.store.remove(&id)
}

#[tauri::command]
pub async fn connection_test(
    config: ConnectionConfig,
    password: Option<String>,
    ssh_secret: Option<String>,
) -> AppResult<ServerInfo> {
    let password = resolve_password(&config, password);
    let probed = manager::probe(&config, password.as_deref(), ssh_secret.as_deref()).await;
    let (info, _, _) = logged(probed, || {
        format!("Connection test to {} failed", describe(&config))
    })?;
    Ok(info)
}

#[tauri::command]
pub async fn connection_open(
    state: State<'_, AppState>,
    id: String,
    password: Option<String>,
    remember: Option<bool>,
) -> AppResult<ServerInfo> {
    let mut config = state.store.get(&id)?;
    let password = resolve_password(&config, password);
    if password.is_none() && needs_password(&config) {
        return Err(AppError::PasswordRequired);
    }
    let info = logged(
        state.manager.open(config.clone(), password.clone()).await,
        || format!("Connecting to {} failed", describe(&config)),
    )?;
    if remember == Some(true)
        && let Some(p) = &password
    {
        config::store_password(&id, p)?;
        config.save_password = true;
        state.store.upsert(config)?;
    }
    state.store.touch(&id);
    Ok(info)
}

/// Trusts the SSH host key a `host_key_unknown` error showed the user
#[tauri::command]
pub async fn ssh_trust_host_key(token: String) -> AppResult<()> {
    crate::tunnel::trust_host_key(&token).await
}

#[tauri::command]
pub fn connection_close(state: State<'_, AppState>, id: String) {
    state.manager.close(&id);
}

#[tauri::command]
pub async fn db_databases(state: State<'_, AppState>, id: String) -> AppResult<Vec<DatabaseInfo>> {
    let result = async { state.manager.get(&id)?.list_databases().await }.await;
    logged(result, || {
        format!(
            "Listing databases on {} failed",
            connection_label(&state, &id)
        )
    })
}

#[tauri::command]
pub async fn db_schemas(
    state: State<'_, AppState>,
    id: String,
    database: String,
) -> AppResult<Vec<SchemaInfo>> {
    let result = async { state.manager.get(&id)?.list_schemas(&database).await }.await;
    logged(result, || {
        format!(
            "Listing schemas in {database} on {} failed",
            connection_label(&state, &id)
        )
    })
}

#[tauri::command]
pub async fn db_objects(
    state: State<'_, AppState>,
    id: String,
    database: String,
    schema: Option<String>,
) -> AppResult<Vec<DbObject>> {
    let result = async {
        state
            .manager
            .get(&id)?
            .list_objects(&database, schema.as_deref())
            .await
    }
    .await;
    logged(result, || {
        format!(
            "Listing objects in {database} on {} failed",
            connection_label(&state, &id)
        )
    })
}

#[tauri::command]
pub async fn db_table(
    state: State<'_, AppState>,
    id: String,
    database: String,
    schema: Option<String>,
    name: String,
) -> AppResult<TableInfo> {
    let result = async {
        state
            .manager
            .get(&id)?
            .describe_table(&database, schema.as_deref(), &name)
            .await
    }
    .await;
    logged(result, || {
        format!(
            "Describing table {name} on {} failed",
            connection_label(&state, &id)
        )
    })
}

#[tauri::command]
pub async fn db_definition(
    state: State<'_, AppState>,
    id: String,
    database: String,
    schema: Option<String>,
    name: String,
    kind: String,
    detail: Option<String>,
) -> AppResult<Option<String>> {
    let result = async {
        state
            .manager
            .get(&id)?
            .object_definition(
                &database,
                schema.as_deref(),
                &name,
                &kind,
                detail.as_deref(),
            )
            .await
    }
    .await;
    logged(result, || {
        format!(
            "Loading the definition of {kind} {name} on {} failed",
            connection_label(&state, &id)
        )
    })
}

#[tauri::command]
pub async fn db_routine(
    state: State<'_, AppState>,
    id: String,
    database: String,
    schema: Option<String>,
    name: String,
    kind: String,
    detail: Option<String>,
) -> AppResult<RoutineInfo> {
    let result = async {
        state
            .manager
            .get(&id)?
            .describe_routine(
                &database,
                schema.as_deref(),
                &name,
                &kind,
                detail.as_deref(),
            )
            .await
    }
    .await;
    logged(result, || {
        format!(
            "Describing routine {kind} {name} on {} failed",
            connection_label(&state, &id)
        )
    })
}

#[tauri::command]
pub async fn db_completion(
    state: State<'_, AppState>,
    id: String,
    database: String,
) -> AppResult<Vec<CompletionTable>> {
    let result = async { state.manager.get(&id)?.completion(&database).await }.await;
    logged(result, || {
        format!(
            "Loading completions for {database} on {} failed",
            connection_label(&state, &id)
        )
    })
}

#[tauri::command]
pub async fn query_execute(
    state: State<'_, AppState>,
    id: String,
    session: String,
    database: String,
    sql: String,
    options: Option<ExecOptions>,
) -> AppResult<ExecOutput> {
    let result = async {
        let server = state.manager.get(&id)?;
        server
            .execute(&session, &database, &sql, &options.unwrap_or_default())
            .await
    }
    .await;
    let context = || {
        format!(
            "Query on {} ({database}) failed",
            connection_label(&state, &id)
        )
    };
    // Statement errors come back inside the output rather than as an Err
    if let Ok(output) = &result
        && let Some(error) = &output.error
    {
        let at = error
            .line
            .map(|l| format!(" at line {l}"))
            .unwrap_or_default();
        log::error!(
            "{}{at}: {}
  SQL: {}",
            context(),
            error.message,
            snippet(&sql)
        );
    }
    logged(result, || {
        format!(
            "{}
  SQL: {}",
            context(),
            snippet(&sql)
        )
    })
}

/// Runs `sql` on the tab's session and writes every row of result set `set`
/// to `path` as it arrives, past the grid's row limit. Other result sets are
/// only counted. The file must have been picked in a save dialog.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn query_export(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    session: String,
    database: String,
    sql: String,
    format: crate::export::ExportFormat,
    path: String,
    set: Option<usize>,
) -> AppResult<ExecOutput> {
    crate::file_scope::check(&app, &path)?;
    let result = async {
        let sink = crate::export::sink(format, &path)?;
        let handle = SinkHandle::new(sink, set.unwrap_or(0));
        let opts = ExecOptions {
            // Sets other than the exported one keep a few rows, for the messages
            max_rows: 100,
            max_binary_bytes: usize::MAX,
            sink: Some(handle.clone()),
            // Only offered for text that just reads; the backend check backs that up
            read_only: true,
        };
        let server = state.manager.get(&id)?;
        let output = server.execute(&session, &database, &sql, &opts).await?;
        if let Some(e) = handle.error.lock().take() {
            return Err(AppError::msg(format!("Couldn't write {path}: {e}")));
        }
        Ok(output)
    }
    .await;
    logged(result, || {
        format!(
            "Export from {} ({database}) failed
  SQL: {}",
            connection_label(&state, &id),
            snippet(&sql)
        )
    })
}

#[tauri::command]
pub fn query_cancel(state: State<'_, AppState>, id: String, session: String) -> AppResult<()> {
    state.manager.get(&id)?.cancel(&session);
    Ok(())
}

#[tauri::command]
pub async fn session_close(
    state: State<'_, AppState>,
    id: String,
    session: String,
) -> AppResult<()> {
    if let Ok(server) = state.manager.get(&id) {
        server.close_session(&session).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn mongo_execute(
    state: State<'_, AppState>,
    id: String,
    session: String,
    request: MongoRequest,
    options: Option<ExecOptions>,
) -> AppResult<MongoOutput> {
    let result = async {
        let server = state.manager.get(&id)?;
        server
            .mongo_execute(&session, request, &options.unwrap_or_default())
            .await
    }
    .await;
    logged(result, || {
        format!(
            "MongoDB command on {} failed",
            connection_label(&state, &id)
        )
    })
}

#[tauri::command]
pub async fn file_write_text(
    app: tauri::AppHandle,
    path: String,
    contents: String,
) -> AppResult<()> {
    crate::file_scope::check(&app, &path)?;
    tokio::fs::write(&path, contents).await?;
    Ok(())
}

/// Binary contents arrive as the raw request body (no JSON number arrays), with
/// the URI-encoded destination in the `x-path` header.
#[tauri::command]
pub async fn file_write_bytes(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> AppResult<()> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::msg("Expected binary contents"));
    };
    let path = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError::msg("Missing destination path"))?;
    let path = percent_decode(path)?;
    crate::file_scope::check(&app, &path)?;
    tokio::fs::write(&path, bytes).await?;
    Ok(())
}

/// Writes rows the grid holds as a one-sheet Excel workbook.
#[tauri::command]
pub async fn file_write_xlsx(
    app: tauri::AppHandle,
    path: String,
    columns: Vec<ColumnMeta>,
    rows: Vec<Vec<serde_json::Value>>,
) -> AppResult<()> {
    crate::file_scope::check(&app, &path)?;
    tokio::task::spawn_blocking(move || crate::export::write_xlsx(&path, &columns, &rows))
        .await
        .map_err(|e| AppError::msg(e.to_string()))??;
    Ok(())
}

fn percent_decode(s: &str) -> AppResult<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(b) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).map_err(|_| AppError::msg("Invalid destination path"))
}

#[tauri::command]
pub async fn file_read_text(app: tauri::AppHandle, path: String) -> AppResult<String> {
    crate::file_scope::check(&app, &path)?;
    Ok(tokio::fs::read_to_string(&path).await?)
}

/// UI state (open tabs, history, settings) lives in small JSON files rather than
/// webview localStorage, which loses recent writes when the process is killed.
fn state_dir(app: &tauri::AppHandle) -> AppResult<std::path::PathBuf> {
    use tauri::Manager as _;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::msg(e.to_string()))?
        .join("state");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn state_file(app: &tauri::AppHandle, key: &str) -> AppResult<std::path::PathBuf> {
    if key.is_empty()
        || !key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
    {
        return Err(AppError::msg("Invalid state key"));
    }
    Ok(state_dir(app)?.join(format!("{key}.json")))
}

#[tauri::command]
pub fn state_load_all(
    app: tauri::AppHandle,
) -> AppResult<std::collections::HashMap<String, String>> {
    let mut out = std::collections::HashMap::new();
    for entry in std::fs::read_dir(state_dir(&app)?)?.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "json")
            && let (Some(stem), Ok(text)) = (
                path.file_stem().and_then(|s| s.to_str()),
                std::fs::read_to_string(&path),
            )
        {
            out.insert(stem.to_string(), text);
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn state_save(app: tauri::AppHandle, key: String, value: String) -> AppResult<()> {
    let path = state_file(&app, &key)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, value)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

#[tauri::command]
pub fn cloud_tools() -> Vec<crate::cloud::CloudTool> {
    crate::cloud::tools()
}

/// Runs a cloud CLI; `{secret}` in `args` becomes the path of a temporary file
/// holding `secret`. `workdir` names an app-managed folder to run in, for CLIs
/// that act on the current directory. `account` picks one the user added.
#[tauri::command]
pub async fn cloud_cli(
    provider: crate::cloud::Provider,
    args: Vec<String>,
    secret: Option<String>,
    timeout_secs: Option<u64>,
    workdir: Option<String>,
    account: Option<String>,
) -> AppResult<String> {
    crate::cloud::check_args(provider, &args)?;
    crate::cloud::run(
        provider,
        args,
        secret,
        timeout_secs,
        workdir.as_deref(),
        account.as_deref().unwrap_or_default(),
    )
    .await
}

/// Backup and restore tools for an engine; `dir` is a folder to search first.
#[tauri::command]
pub async fn backup_tools(engine: Engine, dir: Option<String>) -> Vec<crate::backup::Tool> {
    let kinds = crate::backup::ToolKind::for_engine(engine);
    futures_util::future::join_all(
        kinds
            .iter()
            .map(|kind| crate::backup::resolve(*kind, dir.as_deref())),
    )
    .await
}

/// The command line a backup job would run, for review before starting it.
#[tauri::command]
pub async fn backup_preview(
    state: State<'_, AppState>,
    id: String,
    job: crate::backup::Job,
    dir: Option<String>,
) -> AppResult<String> {
    let server = state.manager.get(&id)?;
    let tool = crate::backup::resolve(job.kind(), dir.as_deref()).await;
    let plan = job.plan(&server.config, server.password(), &tool)?;
    // Without the tool, the built-in engine runs the job
    if tool.path.is_none() {
        crate::backup::builtin::supports(&job)?;
        return Ok(crate::backup::builtin::describe(&job));
    }
    Ok(crate::backup::command_line(&tool, &plan))
}

#[tauri::command]
pub async fn backup_inspect(
    state: State<'_, AppState>,
    id: String,
    path: String,
    dir: Option<String>,
) -> AppResult<crate::backup::Inspection> {
    let server = state.manager.get(&id)?;
    crate::backup::inspect(
        server.config.engine,
        &path,
        &server.config,
        server.password(),
        dir.as_deref(),
    )
    .await
}

/// Runs a backup or restore to completion, emitting `backup-progress` events
/// tagged with `job_id` as it goes.
#[tauri::command]
pub async fn backup_run(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    job_id: String,
    job: crate::backup::Job,
    dir: Option<String>,
) -> AppResult<crate::backup::Outcome> {
    let server = state.manager.get(&id)?;
    if job.is_restore() && server.config.read_only {
        return Err(AppError::msg(
            "This connection is read-only, so restoring is blocked. \
             Turn off \"Read-only\" in the connection settings to restore.",
        ));
    }
    let tool = crate::backup::resolve(job.kind(), dir.as_deref()).await;
    let plan = job.plan(&server.config, server.password(), &tool)?;
    if tool.path.is_none() {
        return crate::backup::builtin::run(&app, &state.backups, &job_id, &server, &job).await;
    }
    crate::backup::run(&app, &state.backups, &job_id, &tool, plan).await
}

#[tauri::command]
pub fn backup_cancel(state: State<'_, AppState>, job_id: String) {
    state.backups.cancel(&job_id);
}

/// Whether an API token is saved for a provider's account.
#[tauri::command]
pub fn cloud_token_status(provider: crate::cloud::Provider, account: Option<String>) -> bool {
    crate::cloud::stored_token(provider, account.as_deref().unwrap_or_default()).is_some()
}

#[tauri::command]
pub fn cloud_token_set(
    provider: crate::cloud::Provider,
    token: String,
    account: Option<String>,
) -> AppResult<()> {
    crate::cloud::store_token(provider, account.as_deref().unwrap_or_default(), &token)
}

#[tauri::command]
pub fn cloud_token_delete(provider: crate::cloud::Provider, account: Option<String>) {
    crate::cloud::delete_token(provider, account.as_deref().unwrap_or_default());
}

/// Calls a provider's REST API with the account's saved token (or flyctl's).
#[tauri::command]
pub async fn cloud_api(
    provider: crate::cloud::Provider,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
    account: Option<String>,
) -> AppResult<serde_json::Value> {
    let token = crate::cloud::api_token(provider, account.as_deref().unwrap_or_default()).await?;
    crate::cloud::api(provider, &method, &path, body, Some(&token)).await
}

/// The current log file, as named by `tauri_plugin_log`'s log-dir target.
fn log_file(app: &tauri::AppHandle) -> AppResult<std::path::PathBuf> {
    use tauri::Manager as _;
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|e| AppError::msg(e.to_string()))?;
    Ok(dir.join(format!("{}.log", app.package_info().name)))
}

#[tauri::command]
pub fn logs_reveal(app: tauri::AppHandle) -> AppResult<()> {
    use tauri_plugin_opener::OpenerExt as _;
    let path = log_file(&app)?;
    // Nothing has failed yet; create the file so there is something to show
    if !path.exists() {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::File::create(&path)?;
    }
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| AppError::msg(e.to_string()))
}

/// The end of the current log file (empty when nothing has been logged).
#[tauri::command]
pub async fn logs_read(app: tauri::AppHandle) -> AppResult<String> {
    const MAX: usize = 256 * 1024;
    let bytes = match tokio::fs::read(log_file(&app)?).await {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(e) => return Err(e.into()),
    };
    let text = String::from_utf8_lossy(&bytes[bytes.len().saturating_sub(MAX)..]);
    // Start at a whole line when the tail cut one in half
    Ok(match (bytes.len() > MAX, text.find('\n')) {
        (true, Some(i)) => text[i + 1..].to_string(),
        _ => text.into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logged_sql_hides_quoted_strings() {
        assert_eq!(
            snippet("ALTER USER app IDENTIFIED BY 'hunter2'"),
            "ALTER USER app IDENTIFIED BY '…'"
        );
        assert_eq!(
            snippet("insert into t values ('it''s', \"x\") -- done"),
            "insert into t values ('…', \"…\") -- done"
        );
        assert_eq!(snippet(r"SELECT 'a\'b secret' FROM t"), "SELECT '…' FROM t");
        assert_eq!(snippet("SELECT 1"), "SELECT 1");
    }
}
