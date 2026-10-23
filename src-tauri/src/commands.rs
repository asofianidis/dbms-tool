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
}

/// Whether connecting needs a password the user hasn't given us.
fn needs_password(config: &ConnectionConfig) -> bool {
    if config.engine == Engine::Mongo {
        // A URI may carry its own credentials; only ask when we built it ourselves
        return config.uri.trim().is_empty() && !config.user.is_empty();
    }
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
