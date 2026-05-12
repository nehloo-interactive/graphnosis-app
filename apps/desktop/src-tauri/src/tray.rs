//! Menu-bar (tray) UX for Graphnosis.
//!
//! Shows a status row at the top of the dropdown ("Locked" / "Unlocked · vault"),
//! plus actions: Show window, Open vault in Finder, Lock vault, Quit.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Wry,
};

use crate::{AppState, StatusSnapshot};

/// Build the tray icon + menu and register event handlers.
pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app, &StatusSnapshot {
        unlocked: false,
        vault_dir: None,
        sidecar_running: false,
    })?;

    TrayIconBuilder::with_id("graphnosis-tray")
        .icon(app.default_window_icon().cloned().unwrap_or_else(|| {
            // Fall back: solid square. App icon is the bundled icon.png.
            tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))
                .expect("32x32.png must exist in icons/")
        }))
        .icon_as_template(true) // adapts to macOS light/dark menu bar
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            on_menu_event(app, event.id().as_ref());
        })
        .on_tray_icon_event(|tray, event| {
            // Single-click on the tray icon → also opens the menu (already default).
            // Right-click is unused — we keep all actions in the menu for clarity.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = tray.app_handle();
            }
        })
        .build(app)?;

    Ok(())
}

/// Rebuild the tray menu in place to reflect new status.
///
/// Called from `unlock_vault` and `lock_vault` so the user immediately sees
/// state changes without having to reopen the dropdown.
pub fn refresh_status(app: &AppHandle, status: &StatusSnapshot) {
    let Some(tray) = app.tray_by_id("graphnosis-tray") else { return };
    if let Ok(menu) = build_menu(app, status) {
        let _ = tray.set_menu(Some(menu));
    }
}

fn build_menu(app: &AppHandle, status: &StatusSnapshot) -> tauri::Result<Menu<Wry>> {
    let status_label = if status.unlocked {
        let vault = status
            .vault_dir
            .as_deref()
            .map(short_vault_label)
            .unwrap_or_else(|| "vault".to_string());
        format!("● Unlocked · {}", vault)
    } else {
        "○ Locked".to_string()
    };

    let status_item = MenuItem::with_id(app, "status", &status_label, false, None::<&str>)?;
    let show_item = MenuItem::with_id(
        app,
        "show",
        if status.unlocked { "Open inspector…" } else { "Unlock vault…" },
        true,
        None::<&str>,
    )?;
    let open_folder_item = MenuItem::with_id(
        app,
        "open_folder",
        "Open vault folder",
        status.unlocked,
        None::<&str>,
    )?;
    let lock_item = MenuItem::with_id(app, "lock", "Lock vault", status.unlocked, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit Graphnosis", true, Some("CmdOrCtrl+Q"))?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    Menu::with_items(
        app,
        &[
            &status_item,
            &sep1,
            &show_item,
            &open_folder_item,
            &lock_item,
            &sep2,
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
        "open_folder" => {
            let app_clone = app.clone();
            tauri::async_runtime::spawn(async move {
                let state = app_clone.state::<AppState>();
                let path = {
                    let inner = state.inner.lock().await;
                    inner.vault_dir.clone()
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
                    if let Some(vd) = inner.vault_dir.as_ref() {
                        let vd_str = vd.to_string_lossy().into_owned();
                        let _ = crate::keychain::clear_passphrase(&vd_str);
                    }
                }
                let snapshot = StatusSnapshot {
                    unlocked: false,
                    vault_dir: None,
                    sidecar_running: false,
                };
                use tauri::Emitter;
                let _ = app_clone.emit("graphnosis://status", &snapshot);
                refresh_status(&app_clone, &snapshot);
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

/// Truncate a vault path to its last two components for the tray label.
fn short_vault_label(path: &str) -> String {
    let parts: Vec<&str> = path.rsplit('/').take(2).collect();
    let mut tail: Vec<&str> = parts.into_iter().rev().collect();
    let label = tail.join("/");
    if label.is_empty() {
        path.to_string()
    } else {
        label
    }
}
