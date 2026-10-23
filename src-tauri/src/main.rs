// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Started by ssh to supply an SSH password or passphrase (see tunnel.rs)
    if dbms_tool_lib::answer_askpass() {
        return;
    }
    dbms_tool_lib::run()
}
