//! Menu-bar (tray) UX for Graphnosis.
//!
//! Shows a status row at the top of the dropdown ("Locked" / "Unlocked · cortex"),
//! plus actions: Show window, Open cortex in Finder, Lock cortex, Quit.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, Wry,
};

use crate::{AppState, StatusSnapshot};

/// Build the tray icon + menu and register event handlers.
pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app, &StatusSnapshot {
        unlocked: false,
        cortex_dir: None,
        sidecar_running: false,
    })?;

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

/// Rebuild the tray menu in place to reflect new status.
///
/// Called from `unlock_cortex` and `lock_cortex` so the user immediately sees
/// state changes without having to reopen the dropdown.
pub fn refresh_status(app: &AppHandle, status: &StatusSnapshot) {
    let Some(tray) = app.tray_by_id("graphnosis-tray") else { return };
    if let Ok(menu) = build_menu(app, status) {
        let _ = tray.set_menu(Some(menu));
    }
}

fn build_menu(app: &AppHandle, status: &StatusSnapshot) -> tauri::Result<Menu<Wry>> {
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
