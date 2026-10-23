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
) -> AppResult<ConnectionConfig> {
    let saved = state.store.upsert(config)?;
    if saved.save_password {
        if let Some(p) = password {
            config::store_password(&saved.id, &p)?;
        }
    } else {
        config::delete_password(&saved.id);
    }
    Ok(saved)
}

#[tauri::command]
pub fn connection_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.manager.close(&id);
    config::delete_password(&id);
    state.store.remove(&id)
}

#[tauri::command]
pub async fn connection_test(
    config: ConnectionConfig,
    password: Option<String>,
) -> AppResult<ServerInfo> {
    let password = resolve_password(&config, password);
    let (info, _, _) = manager::probe(&config, password.as_deref()).await?;
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
    let info = state.manager.open(config.clone(), password.clone()).await?;
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

#[tauri::command]
pub fn connection_close(state: State<'_, AppState>, id: String) {
    state.manager.close(&id);
}

#[tauri::command]
pub async fn db_databases(state: State<'_, AppState>, id: String) -> AppResult<Vec<DatabaseInfo>> {
    state.manager.get(&id)?.list_databases().await
}

#[tauri::command]
pub async fn db_schemas(
    state: State<'_, AppState>,
    id: String,
    database: String,
) -> AppResult<Vec<SchemaInfo>> {
    state.manager.get(&id)?.list_schemas(&database).await
}

#[tauri::command]
pub async fn db_objects(
    state: State<'_, AppState>,
    id: String,
    database: String,
    schema: Option<String>,
) -> AppResult<Vec<DbObject>> {
    state
        .manager
        .get(&id)?
        .list_objects(&database, schema.as_deref())
        .await
}

#[tauri::command]
pub async fn db_table(
    state: State<'_, AppState>,
    id: String,
    database: String,
    schema: Option<String>,
    name: String,
) -> AppResult<TableInfo> {
    state
        .manager
        .get(&id)?
        .describe_table(&database, schema.as_deref(), &name)
        .await
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

#[tauri::command]
pub async fn db_completion(
    state: State<'_, AppState>,
    id: String,
    database: String,
) -> AppResult<Vec<CompletionTable>> {
    state.manager.get(&id)?.completion(&database).await
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
    let server = state.manager.get(&id)?;
    server
        .execute(&session, &database, &sql, &options.unwrap_or_default())
        .await
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
    let server = state.manager.get(&id)?;
    server
        .mongo_execute(&session, request, &options.unwrap_or_default())
        .await
}

#[tauri::command]
pub async fn file_write_text(path: String, contents: String) -> AppResult<()> {
    tokio::fs::write(&path, contents).await?;
    Ok(())
}

/// Binary contents arrive as the raw request body (no JSON number arrays), with
/// the URI-encoded destination in the `x-path` header.
#[tauri::command]
pub async fn file_write_bytes(request: tauri::ipc::Request<'_>) -> AppResult<()> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::msg("Expected binary contents"));
    };
    let path = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError::msg("Missing destination path"))?;
    let path = percent_decode(path)?;
    tokio::fs::write(&path, bytes).await?;
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
pub async fn file_read_text(path: String) -> AppResult<String> {
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
