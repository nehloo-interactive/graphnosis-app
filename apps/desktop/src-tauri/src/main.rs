#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod keychain;
mod sidecar;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Mutex;

#[derive(Default)]
struct AppState {
    vault_dir: Mutex<Option<PathBuf>>,
    sidecar: Mutex<Option<sidecar::SidecarHandle>>,
}

#[derive(Serialize, Deserialize)]
struct UnlockArgs {
    vault_dir: String,
    passphrase: String,
}

#[tauri::command]
async fn pick_vault_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let result = app
        .dialog()
        .file()
        .set_title("Choose a folder for your Graphnosis memory")
        .blocking_pick_folder();
    Ok(result.and_then(|f| f.into_path().ok()).map(|p| p.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn unlock_vault(state: State<'_, AppState>, args: UnlockArgs) -> Result<(), String> {
    let vault_dir = PathBuf::from(&args.vault_dir);
    if !vault_dir.is_dir() {
        return Err(format!("Vault folder does not exist: {}", args.vault_dir));
    }
    keychain::store_passphrase(&args.vault_dir, &args.passphrase).map_err(|e| e.to_string())?;
    let handle = sidecar::start(&vault_dir, &args.passphrase).await.map_err(|e| e.to_string())?;
    *state.vault_dir.lock().await = Some(vault_dir);
    *state.sidecar.lock().await = Some(handle);
    Ok(())
}

#[tauri::command]
async fn lock_vault(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(handle) = state.sidecar.lock().await.take() {
        handle.shutdown().await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![pick_vault_folder, unlock_vault, lock_vault])
        .setup(|app| {
            // Menu-bar app: keep the main window hidden by default; show on user action.
            #[cfg(target_os = "macos")]
            {
                use tauri::ActivationPolicy;
                let _ = app.set_activation_policy(ActivationPolicy::Accessory);
            }
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.hide();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Graphnosis");
}

fn main() {
    run();
}
