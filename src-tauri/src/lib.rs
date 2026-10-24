mod backup;
mod cloud;
mod commands;
mod config;
mod drivers;
mod error;
mod export;
mod file_scope;
mod guard;
#[cfg(test)]
mod integration_tests;
mod limits;
mod manager;
mod model;
mod tunnel;

use tauri::Manager as _;

use commands::AppState;
pub use tunnel::answer_askpass;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Failures go to stdout and the OS log dir (%LOCALAPPDATA%\<identifier>\logs on Windows)
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .max_file_size(5 * 1024 * 1024)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(5))
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        // Only for the scope dialogs add picked files to; grants the webview nothing
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            file_scope::init(app.handle())?;
            let dir = app.path().app_config_dir()?;
            app.manage(AppState {
                store: config::ConnectionStore::load(dir),
                manager: manager::Manager::default(),
                backups: backup::Jobs::default(),
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
            commands::ssh_trust_host_key,
            commands::limits_set,
            commands::db_databases,
            commands::db_schemas,
            commands::db_objects,
            commands::db_table,
            commands::db_definition,
            commands::db_routine,
            commands::db_completion,
            commands::query_execute,
            commands::query_cancel,
            commands::query_export,
            commands::session_close,
            commands::mongo_execute,
            commands::file_write_text,
            commands::file_write_bytes,
            commands::file_write_xlsx,
            commands::file_read_text,
            commands::state_load_all,
            commands::state_save,
            commands::cloud_tools,
            commands::cloud_cli,
            commands::cloud_token_status,
            commands::cloud_token_set,
            commands::cloud_token_delete,
            commands::cloud_api,
            commands::backup_tools,
            commands::backup_preview,
            commands::backup_inspect,
            commands::backup_run,
            commands::backup_cancel,
            commands::logs_reveal,
            commands::logs_read,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
