mod commands;
mod config;
mod drivers;
mod error;
mod guard;
#[cfg(test)]
mod integration_tests;
mod manager;
mod model;

use tauri::Manager as _;

use commands::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            let dir = app.path().app_config_dir()?;
            app.manage(AppState {
                store: config::ConnectionStore::load(dir),
                manager: manager::Manager::default(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connections_list,
            commands::connection_save,
            commands::connection_delete,
            commands::connection_test,
            commands::connection_open,
            commands::connection_close,
            commands::db_databases,
            commands::db_schemas,
            commands::db_objects,
            commands::db_table,
            commands::db_definition,
            commands::db_routine,
            commands::db_completion,
            commands::query_execute,
            commands::query_cancel,
            commands::session_close,
            commands::mongo_execute,
            commands::file_write_text,
            commands::file_write_bytes,
            commands::file_read_text,
            commands::state_load_all,
            commands::state_save,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
