//! Which files the frontend may read and write through `file_read_text` and
//! `file_write_*`: only ones the user picked in an open or save dialog.
//!
//! The dialog plugin adds each picked path to the fs plugin's scope; the fs
//! plugin is registered for that scope alone and grants the webview nothing.
//! Picked files are remembered across restarts (an open tab saves back to its
//! file), in a file outside the `state/` folder the frontend can write to.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use tauri::scope::fs::Event;
use tauri::{AppHandle, Manager as _, Runtime};
use tauri_plugin_fs::FsExt as _;

use crate::error::{AppError, AppResult};

const FILE_NAME: &str = "allowed-files.json";

/// Restores remembered files into the scope and records newly picked ones.
pub fn init<R: Runtime>(app: &AppHandle<R>) -> AppResult<()> {
    let store = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::msg(e.to_string()))?
        .join(FILE_NAME);
    let saved: BTreeSet<PathBuf> = std::fs::read_to_string(&store)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let scope = app.fs_scope();
    for path in &saved {
        let _ = scope.allow_file(path);
    }
    let known = Mutex::new(saved);
    scope.listen(move |event| {
        // Folders picked for backups are scoped for this run only
        let Event::PathAllowed(path) = event else {
            return;
        };
        if path.is_dir() {
            return;
        }
        let mut known = known.lock();
        if known.insert(path.clone()) {
            let _ = save(&store, &known);
        }
    });
    Ok(())
}

fn save(store: &Path, paths: &BTreeSet<PathBuf>) -> AppResult<()> {
    if let Some(dir) = store.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = store.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(paths)?)?;
    std::fs::rename(&tmp, store)?;
    Ok(())
}

/// Fails unless the user picked `path` in a dialog.
pub fn check<R: Runtime>(app: &AppHandle<R>, path: &str) -> AppResult<()> {
    if app.fs_scope().is_allowed(path) {
        Ok(())
    } else {
        Err(AppError::msg(format!(
            "{path} wasn't chosen in a file dialog; open or save it from the menu again"
        )))
    }
}
