//! Menu-bar (tray) UX for Graphnosis.
//!
//! Shows a status row at the top of the dropdown ("Locked" / "Unlocked · cortex"),
//! plus actions: Show window, Open cortex in Finder, Lock cortex, Quit.
//! Also surfaces an "Update Available" item (or "Check for Updates") depending
//! on whether a pending update has been detected by the background checker.

use tauri::{
    Emitter,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, Wry,
};
use tauri_plugin_autostart::ManagerExt;

use crate::{AppState, StatusSnapshot};

/// Read the current autostart state, defaulting to false on any error.
fn autostart_enabled(app: &AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// Build the tray icon + menu and register event handlers.
pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let launch_at_login = autostart_enabled(app);
    let menu = build_menu(app, &StatusSnapshot {
        unlocked: false,
        cortex_dir: None,
        sidecar_running: false,
        sso_session: None,
    }, None, launch_at_login)?;

    // Use the dedicated menu-bar icon (18×18, designed as a template image)
    // so it fits naturally alongside other menu-bar icons and adapts to
    // macOS light/dark mode. Falls back to the default window icon if for
    // some reason the bytes can't be decoded.
    const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/menubar-icon.png");
    let tray_icon = {
        use image::GenericImageView as _;
        image::load_from_memory(TRAY_ICON_BYTES)
            .ok()
            .map(|img| {
                let (w, h) = img.dimensions();
                let rgba = img.into_rgba8().into_raw();
                tauri::image::Image::new_owned(rgba, w, h)
            })
            .or_else(|| app.default_window_icon().cloned())
    };

    let mut builder = TrayIconBuilder::with_id("graphnosis-tray")
        .icon_as_template(true) // transparent bg → macOS colorises white/black per menu-bar style
        .menu(&menu)
        .show_menu_on_left_click(true);
    if let Some(icon) = tray_icon {
        builder = builder.icon(icon);
    }
    builder
        .on_menu_event(|app, event| {
            on_menu_event(app, event.id().as_ref());
        })
        .build(app)?;

    Ok(())
}

/// Like `refresh_status` but accepts a pre-read autostart state — avoids a
/// second plist read when the caller just toggled autostart and already knows
/// the new value.
pub fn refresh_status_with_autostart(app: &AppHandle, status: &StatusSnapshot, launch_at_login: bool) {
    let Some(tray) = app.tray_by_id("graphnosis-tray") else { return };
    let update_version: Option<String> = app
        .try_state::<crate::UpdateState>()
        .and_then(|s| {
            s.available_version
                .lock()
                .ok()
                .and_then(|guard| guard.as_ref().map(|v| v.clone()))
        });
    if let Ok(menu) = build_menu(app, status, update_version.as_deref(), launch_at_login) {
        let _ = tray.set_menu(Some(menu));
    }
}

/// Rebuild the tray menu in place to reflect new status.
///
/// Called from `unlock_cortex` and `lock_cortex` so the user immediately sees
/// state changes without having to reopen the dropdown. Automatically reads
/// any pending update version from `UpdateState` (if registered) to show
/// "Update Available — vX.Y.Z" instead of the normal "Check for Updates" item.
pub fn refresh_status(app: &AppHandle, status: &StatusSnapshot) {
    let Some(tray) = app.tray_by_id("graphnosis-tray") else { return };
    // Read the pending update version synchronously from UpdateState.
    let update_version: Option<String> = app
        .try_state::<crate::UpdateState>()
        .and_then(|s| {
            s.available_version
                .lock()
                .ok()
                .and_then(|guard| guard.as_ref().map(|v| v.clone()))
        });
    let launch_at_login = autostart_enabled(app);
    if let Ok(menu) = build_menu(app, status, update_version.as_deref(), launch_at_login) {
        let _ = tray.set_menu(Some(menu));
    }
}

fn build_menu(app: &AppHandle, status: &StatusSnapshot, update_version: Option<&str>, launch_at_login: bool) -> tauri::Result<Menu<Wry>> {
    let status_label = if status.unlocked {
        let cortex = status
            .cortex_dir
            .as_deref()
            .map(short_cortex_label)
            .unwrap_or_else(|| "cortex".to_string());
        format!("● Unlocked · {}", cortex)
    } else {
        "○ Locked".to_string()
    };

    let status_item = MenuItem::with_id(app, "status", &status_label, false, None::<&str>)?;
    let show_item = MenuItem::with_id(
        app,
        "show",
        if status.unlocked { "Open Graphnosis…" } else { "Unlock cortex…" },
        true,
        None::<&str>,
    )?;
    let open_folder_item = MenuItem::with_id(
        app,
        "open_folder",
        "Open cortex folder",
        status.unlocked,
        None::<&str>,
    )?;
    let lock_item = MenuItem::with_id(app, "lock", "Lock cortex", status.unlocked, None::<&str>)?;

    // Update item: shows the new version when available, otherwise offers a
    // manual check. Same "updates" event ID in both states — the handler
    // inspects UpdateState to decide whether to install or check.
    let update_label = match update_version {
        Some(v) => format!("Update Available — v{}", v),
        None => "Check for Updates".to_string(),
    };
    let update_item = MenuItem::with_id(app, "updates", &update_label, true, None::<&str>)?;

    let launch_item = CheckMenuItem::with_id(
        app,
        "launch_at_login",
        "Launch at Login",
        true,
        launch_at_login,
        None::<&str>,
    )?;
    // Ghampus quick-access. Real kill switch lives inside the Chat tab —
    // tray entry is navigation only. Greyed out while the cortex is locked.
    let ghampus_item = MenuItem::with_id(
        app,
        "ghampus",
        "Open Ghampus Hush",
        status.unlocked,
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit Graphnosis", true, Some("CmdOrCtrl+Q"))?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    let sep4 = PredefinedMenuItem::separator(app)?;
    let sep5 = PredefinedMenuItem::separator(app)?;

    Menu::with_items(
        app,
        &[
            &status_item,
            &sep1,
            &show_item,
            &open_folder_item,
            &lock_item,
            &sep2,
            &ghampus_item,
            &sep5,
            &launch_item,
            &sep3,
            &update_item,
            &sep4,
            &quit_item,
        ],
    )
}

fn on_menu_event(app: &AppHandle, id: &str) {
    match id {
        "show" => {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }
        "ghampus" => {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
            let _ = app.emit("graphnosis://open-tab", "ghampus");
        }
        "open_folder" => {
            let app_clone = app.clone();
            tauri::async_runtime::spawn(async move {
                let state = app_clone.state::<AppState>();
                let path = {
                    let inner = state.inner.lock().await;
                    inner.cortex_dir.clone()
                };
                if let Some(p) = path {
                    let _ = std::process::Command::new("open").arg(&p).spawn();
                }
            });
        }
        "lock" => {
            let app_clone = app.clone();
            tauri::async_runtime::spawn(async move {
                let state = app_clone.state::<AppState>();
                {
                    let mut inner = state.inner.lock().await;
                    if let Some(handle) = inner.sidecar.take() {
                        let _ = handle.shutdown().await;
                    }
                    // Intentionally DO NOT clear the cached passphrase here.
                    // Mirrors the fix in `lock_cortex` — locking the cortex
                    // is "step away," not "forget Touch ID." Clearing on
                    // lock would mean every next-launch Touch ID prompt
                    // has nothing to read and falls back to passphrase
                    // entry, defeating the feature.
                }
                let snapshot = StatusSnapshot {
                    unlocked: false,
                    cortex_dir: None,
                    sidecar_running: false,
                    sso_session: None,
                };
                use tauri::Emitter;
                let _ = app_clone.emit("graphnosis://status", &snapshot);
                refresh_status(&app_clone, &snapshot);
            });
        }
        "launch_at_login" => {
            // Toggle autostart and immediately refresh the tray so the
            // checkmark flips without the user having to reopen the menu.
            let autostart = app.autolaunch();
            let currently_enabled = autostart.is_enabled().unwrap_or(false);
            if currently_enabled {
                let _ = autostart.disable();
            } else {
                let _ = autostart.enable();
            }
            // Read back the real state (in case enable/disable failed) to
            // keep the checkmark honest.
            let new_state = autostart.is_enabled().unwrap_or(!currently_enabled);
            let app_clone = app.clone();
            tauri::async_runtime::spawn(async move {
                let state = app_clone.state::<AppState>();
                let snapshot = {
                    let inner = state.inner.lock().await;
                    StatusSnapshot {
                        unlocked: inner.sidecar.is_some(),
                        cortex_dir: inner.cortex_dir.as_ref().map(|p| p.to_string_lossy().into_owned()),
                        sidecar_running: inner.sidecar.is_some(),
                        sso_session: inner.sso_session.clone(),
                    }
                };
                if let Some(tray) = app_clone.tray_by_id("graphnosis-tray") {
                    let update_version: Option<String> = app_clone
                        .try_state::<crate::UpdateState>()
                        .and_then(|s| {
                            s.available_version
                                .lock()
                                .ok()
                                .and_then(|guard| guard.as_ref().map(|v| v.clone()))
                        });
                    if let Ok(menu) = build_menu(&app_clone, &snapshot, update_version.as_deref(), new_state) {
                        let _ = tray.set_menu(Some(menu));
                    }
                }
            });
        }
        "updates" => {
            // Bring the main window to the front, then either re-emit the
            // pending version (so the in-app modal appears) or run a fresh
            // check (which emits the event itself if an update is found).
            let app_clone = app.clone();
            tauri::async_runtime::spawn(async move {
                // Always try to surface the main window so the modal is visible.
                if let Some(win) = app_clone.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }

                let pending = app_clone
                    .try_state::<crate::UpdateState>()
                    .and_then(|s| {
                        s.available_version
                            .lock()
                            .ok()
                            .and_then(|guard| guard.as_ref().map(|v| v.clone()))
                    });

                if let Some(version) = pending {
                    // Re-emit so the in-app modal appears (or re-appears if
                    // the user previously dismissed it with "Later").
                    let _ = app_clone.emit("graphnosis://update-available", version);
                } else {
                    // No pending update cached — run a silent check now.
                    // run_update_check emits the event itself if an update is found.
                    if let Err(e) = crate::run_update_check(app_clone).await {
                        eprintln!("[updater] manual check failed: {}", e);
                    }
                }
            });
        }
        "quit" => {
            // Cleanly shut down the sidecar before exiting.
            let app_clone = app.clone();
            tauri::async_runtime::spawn(async move {
                let state = app_clone.state::<AppState>();
                let handle = {
                    let mut inner = state.inner.lock().await;
                    inner.sidecar.take()
                };
                if let Some(h) = handle {
                    let _ = h.shutdown().await;
                }
                app_clone.exit(0);
            });
        }
        _ => {}
    }
}

/// Truncate a cortex path to its last two components for the tray label.
fn short_cortex_label(path: &str) -> String {
    let parts: Vec<&str> = path.rsplit('/').take(2).collect();
    let tail: Vec<&str> = parts.into_iter().rev().collect();
    let label = tail.join("/");
    if label.is_empty() {
        path.to_string()
    } else {
        label
    }
}
