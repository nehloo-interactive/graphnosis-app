//! Graphnosis menu-bar app entry point.
//!
//! Responsibilities:
//! - Tauri builder with the plugins we need
//! - Tray (menu-bar) icon + dropdown menu
//! - Commands invoked from the unlock / inspector UI
//! - Supervises the Node sidecar process (single-writer guaranteed by
//!   the sidecar's own vault lock)

mod ipc_client;
mod keychain;
mod sidecar;
mod tray;

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::async_runtime::Mutex as AsyncMutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

/// In-memory app state. Wrapped in async Mutex so commands can mutate safely
/// across awaits without blocking the Tauri runtime.
#[derive(Default)]
pub struct AppState {
    inner: Arc<AsyncMutex<AppInner>>,
}

#[derive(Default)]
struct AppInner {
    vault_dir: Option<PathBuf>,
    sidecar: Option<sidecar::SidecarHandle>,
}

#[derive(Serialize, Deserialize)]
pub struct UnlockArgs {
    pub vault_dir: String,
    pub passphrase: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct StatusSnapshot {
    pub unlocked: bool,
    pub vault_dir: Option<String>,
    pub sidecar_running: bool,
}

// ---------- commands -----------------------------------------------------

#[tauri::command]
async fn pick_vault_folder(app: AppHandle) -> Result<Option<String>, String> {
    let result = app
        .dialog()
        .file()
        .set_title("Choose a folder for your Graphnosis memory")
        .blocking_pick_folder();
    Ok(result
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn unlock_vault(
    app: AppHandle,
    state: State<'_, AppState>,
    args: UnlockArgs,
) -> Result<StatusSnapshot, String> {
    let vault_dir = PathBuf::from(&args.vault_dir);
    if !vault_dir.is_dir() {
        return Err(format!("Vault folder does not exist: {}", args.vault_dir));
    }

    // Persist the passphrase to the OS keychain so subsequent app launches
    // can auto-unlock without re-prompting.
    keychain::store_passphrase(&args.vault_dir, &args.passphrase).map_err(|e| e.to_string())?;

    // Spawn the supervised Node sidecar. The sidecar acquires an exclusive
    // vault lock on its own, so if another sidecar is already running against
    // the same vault, this call will fail visibly.
    let handle = sidecar::start(&vault_dir, &args.passphrase)
        .await
        .map_err(|e| e.to_string())?;

    {
        let mut inner = state.inner.lock().await;
        // If we had a previous sidecar running for a different vault, kill it cleanly.
        if let Some(prev) = inner.sidecar.take() {
            let _ = prev.shutdown().await;
        }
        inner.vault_dir = Some(vault_dir.clone());
        inner.sidecar = Some(handle);
    }

    let snapshot = current_status(&state).await;
    let _ = app.emit("graphnosis://status", &snapshot);
    tray::refresh_status(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
async fn lock_vault(app: AppHandle, state: State<'_, AppState>) -> Result<StatusSnapshot, String> {
    let vault_dir_str = {
        let mut inner = state.inner.lock().await;
        if let Some(handle) = inner.sidecar.take() {
            let _ = handle.shutdown().await;
        }
        inner.vault_dir.as_ref().map(|p| p.to_string_lossy().into_owned())
    };
    if let Some(vd) = vault_dir_str {
        let _ = keychain::clear_passphrase(&vd);
    }
    let snapshot = StatusSnapshot {
        unlocked: false,
        vault_dir: None,
        sidecar_running: false,
    };
    let _ = app.emit("graphnosis://status", &snapshot);
    tray::refresh_status(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
async fn status(state: State<'_, AppState>) -> Result<StatusSnapshot, String> {
    Ok(current_status(&state).await)
}

#[tauri::command]
async fn inspector_stats(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match &inner.vault_dir {
            Some(vd) => vd.join("sidecar.sock"),
            None => return Err("vault is locked".to_string()),
        }
    };
    ipc_client::request(&socket_path, "stats.summary", serde_json::Value::Null)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn open_vault_in_finder(state: State<'_, AppState>) -> Result<(), String> {
    let path = {
        let inner = state.inner.lock().await;
        inner.vault_dir.clone()
    };
    let path = path.ok_or_else(|| "vault is locked".to_string())?;
    // macOS: `open <path>` opens the folder in Finder.
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn show_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
    Ok(())
}

async fn current_status(state: &State<'_, AppState>) -> StatusSnapshot {
    let inner = state.inner.lock().await;
    StatusSnapshot {
        unlocked: inner.vault_dir.is_some() && inner.sidecar.is_some(),
        vault_dir: inner
            .vault_dir
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned()),
        sidecar_running: inner.sidecar.is_some(),
    }
}

// ---------- builder ------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            pick_vault_folder,
            unlock_vault,
            lock_vault,
            status,
            inspector_stats,
            open_vault_in_finder,
            show_window,
        ])
        .setup(|app| {
            // Menu-bar app: hide the dock icon (accessory activation).
            #[cfg(target_os = "macos")]
            {
                let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
            // Hide the main window on startup; user opens it via the tray.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.hide();
            }
            // Tray icon + menu.
            tray::create(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Close button hides the window rather than quitting the app —
            // we're a menu-bar resident; quit is via the tray "Quit" item.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Graphnosis");
}

