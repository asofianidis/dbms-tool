//! Update checks on a chosen release channel.
//!
//! The updater plugin's own `check` command only knows the endpoint in tauri.conf.json, so this
//! one picks the manifest for the channel and hands back the same resource the plugin's
//! `download` and `install` commands work with, letting the JS `Update` class drive the rest.

use serde::Serialize;
use tauri::{Manager as _, ResourceId, Runtime, Url, Webview};
use tauri_plugin_updater::UpdaterExt as _;

use crate::error::{AppError, AppResult};

/// Stable builds are the repository's Latest release.
const STABLE_MANIFEST: &str =
    "https://github.com/asofianidis/dbms-tool/releases/latest/download/latest.json";
/// The `nightly` release only carries a manifest, pointing at the newest build of either channel.
const NIGHTLY_MANIFEST: &str =
    "https://github.com/asofianidis/dbms-tool/releases/download/nightly/latest.json";

/// Mirrors the metadata the plugin's `check` returns, which the JS `Update` class is built from.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    rid: ResourceId,
    current_version: String,
    version: String,
    body: Option<String>,
    raw_json: serde_json::Value,
}

#[tauri::command]
pub async fn update_check<R: Runtime>(
    webview: Webview<R>,
    channel: String,
) -> AppResult<Option<UpdateMetadata>> {
    let endpoint = match channel.as_str() {
        "stable" => STABLE_MANIFEST,
        "nightly" => NIGHTLY_MANIFEST,
        other => return Err(AppError::msg(format!("Unknown update channel: {other}"))),
    };
    let url = Url::parse(endpoint).map_err(|e| AppError::msg(e.to_string()))?;
    let update = webview
        .updater_builder()
        .endpoints(vec![url])
        .and_then(|builder| builder.build())
        .map_err(|e| AppError::msg(e.to_string()))?
        .check()
        .await
        .map_err(|e| AppError::msg(e.to_string()))?;
    Ok(update.map(|update| UpdateMetadata {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        body: update.body.clone(),
        raw_json: update.raw_json.clone(),
        rid: webview.resources_table().add(update),
    }))
}
