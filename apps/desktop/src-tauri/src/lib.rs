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
    // First call right after unlock can race the sidecar's host init —
    // give it a little extra room beyond the default 5s.
    ipc_client::request_with_timeout(
        &socket_path,
        "stats.summary",
        serde_json::Value::Null,
        std::time::Duration::from_secs(15),
    )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ingest_file(
    state: State<'_, AppState>,
    graph_id: Option<String>,
    path: String,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match &inner.vault_dir {
            Some(vd) => vd.join("sidecar.sock"),
            None => return Err("vault is locked".to_string()),
        }
    };
    let params = serde_json::json!({
        "graphId": graph_id.unwrap_or_else(|| "personal".to_string()),
        "path": path,
    });
    // PDF parse + embeddings build + encrypted save can take well over 5s
    // on first ingest (BGE model warm-up). Give it a generous budget.
    ipc_client::request_with_timeout(
        &socket_path,
        "ingest.file",
        params,
        std::time::Duration::from_secs(180),
    )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn pick_and_ingest_file(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<serde_json::Value>, String> {
    // Open a native file picker, then route the chosen file through the
    // existing sidecar ingest pipeline (Markdown / HTML / JSON / CSV / PDF / text).
    let picked = app
        .dialog()
        .file()
        .set_title("Choose a file to ingest into Graphnosis")
        .add_filter("Common ingestible formats", &["md", "markdown", "txt", "html", "htm", "json", "csv", "pdf", "docx"])
        .blocking_pick_file();
    let path = match picked.and_then(|f| f.into_path().ok()) {
        Some(p) => p.to_string_lossy().into_owned(),
        None => return Ok(None), // user cancelled
    };
    let result = ingest_file(state, None, path).await?;
    Ok(Some(result))
}

/// Result of the "Configure Claude Desktop" flow. The UI shows the user what
/// changed so they know exactly what was written.
#[derive(Serialize)]
struct ClaudeConfigResult {
    config_path: String,
    relay_path: String,
    node_path: String,
    socket_path: String,
    /// True if the existing config already had a matching Graphnosis entry
    /// pointing at the same socket — nothing meaningful changed.
    already_configured: bool,
    /// True if we created the file from scratch.
    created_file: bool,
    /// Other MCP servers we preserved untouched (key names only — not values).
    preserved_servers: Vec<String>,
}

/// Write (or update) Claude Desktop's MCP config so its Graphnosis tools
/// connect to *this* App's sidecar over a Unix socket instead of spawning a
/// competing sidecar. Preserves any other MCP servers the user has set up.
///
/// Path: `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS.
/// Other platforms aren't supported yet — Claude Desktop is macOS/Windows only,
/// and the path scheme differs on Windows; we'll add that when we ship Windows.
#[tauri::command]
async fn configure_claude_desktop(
    state: State<'_, AppState>,
) -> Result<ClaudeConfigResult, String> {
    // Need an unlocked vault — the socket path lives inside it.
    let vault_dir = {
        let inner = state.inner.lock().await;
        inner.vault_dir.clone()
    }
    .ok_or_else(|| "Unlock the vault first — Claude needs the vault's socket path.".to_string())?;

    let socket_path = vault_dir.join("mcp.sock");

    let (node, relay) = sidecar::resolve_node_and_relay().map_err(|e| e.to_string())?;

    let config_path = claude_desktop_config_path().ok_or_else(|| {
        "Could not locate Claude Desktop's config directory for this user.".to_string()
    })?;

    // Read existing config (if any). We deliberately fail loudly on unparseable
    // JSON rather than silently overwrite — the user might have hand-edited it.
    let (mut root, created_file) = match std::fs::read_to_string(&config_path) {
        Ok(s) => {
            let parsed: serde_json::Value = serde_json::from_str(&s)
                .map_err(|e| format!("{} is not valid JSON: {}. Fix or remove it, then try again.",
                    config_path.display(), e))?;
            (parsed, false)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            (serde_json::json!({}), true)
        }
        Err(e) => return Err(format!("Could not read {}: {}", config_path.display(), e)),
    };

    // Ensure root is an object and `mcpServers` is an object.
    if !root.is_object() {
        return Err("claude_desktop_config.json root is not a JSON object — aborting.".to_string());
    }
    let root_obj = root.as_object_mut().expect("checked above");
    let mcp_entry = root_obj
        .entry("mcpServers".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !mcp_entry.is_object() {
        return Err("`mcpServers` exists but is not an object — aborting.".to_string());
    }
    let servers = mcp_entry.as_object_mut().expect("checked above");

    // Detect "already configured": same command, same args, same socket.
    let desired_entry = serde_json::json!({
        "command": node.to_string_lossy(),
        "args": [
            relay.to_string_lossy(),
            socket_path.to_string_lossy(),
        ],
    });
    let already_configured = servers.get("Graphnosis") == Some(&desired_entry);

    let preserved_servers: Vec<String> = servers
        .keys()
        .filter(|k| k.as_str() != "Graphnosis")
        .cloned()
        .collect();

    servers.insert("Graphnosis".to_string(), desired_entry);

    // Atomic write: temp + rename so a crash mid-write doesn't corrupt config.
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create {}: {}", parent.display(), e))?;
    }
    let tmp = config_path.with_extension("json.tmp");
    let pretty = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("Could not serialize config: {}", e))?;
    std::fs::write(&tmp, pretty)
        .map_err(|e| format!("Could not write {}: {}", tmp.display(), e))?;
    std::fs::rename(&tmp, &config_path)
        .map_err(|e| format!("Could not finalize {}: {}", config_path.display(), e))?;

    Ok(ClaudeConfigResult {
        config_path: config_path.to_string_lossy().into_owned(),
        relay_path: relay.to_string_lossy().into_owned(),
        node_path: node.to_string_lossy().into_owned(),
        socket_path: socket_path.to_string_lossy().into_owned(),
        already_configured,
        created_file,
        preserved_servers,
    })
}

#[cfg(target_os = "macos")]
fn claude_desktop_config_path() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    Some(home
        .join("Library")
        .join("Application Support")
        .join("Claude")
        .join("claude_desktop_config.json"))
}

#[cfg(not(target_os = "macos"))]
fn claude_desktop_config_path() -> Option<PathBuf> {
    // Windows path scheme is %APPDATA%\Claude\claude_desktop_config.json —
    // wire it up when we ship Windows. Linux Claude Desktop doesn't exist yet.
    None
}

/// Physically remove every soft-deleted node from a graph by rebuilding it
/// from the surviving live sources. Slow — up to a few minutes on big vaults.
#[tauri::command]
async fn purge_forgotten(
    state: State<'_, AppState>,
    graph_id: String,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match &inner.vault_dir {
            Some(vd) => vd.join("sidecar.sock"),
            None => return Err("vault is locked".to_string()),
        }
    };
    let params = serde_json::json!({ "graphId": graph_id });
    ipc_client::request_with_timeout(
        &socket_path,
        "vault.purgeForgotten",
        params,
        std::time::Duration::from_secs(600),
    )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_graphs_with_metadata(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match &inner.vault_dir {
            Some(vd) => vd.join("sidecar.sock"),
            None => return Err("vault is locked".to_string()),
        }
    };
    ipc_client::request(&socket_path, "graphs.listWithMetadata", serde_json::Value::Null)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_graph_with_template(
    state: State<'_, AppState>,
    graph_id: String,
    template: String,
    display_name: String,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match &inner.vault_dir {
            Some(vd) => vd.join("sidecar.sock"),
            None => return Err("vault is locked".to_string()),
        }
    };
    let params = serde_json::json!({
        "graphId": graph_id,
        "template": template,
        "displayName": display_name,
    });
    // Graph creation runs the SDK + save — give it 30s.
    ipc_client::request_with_timeout(
        &socket_path,
        "graphs.createWithTemplate",
        params,
        std::time::Duration::from_secs(30),
    )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn search_nodes(
    state: State<'_, AppState>,
    graph_id: String,
    query: String,
    k: Option<u32>,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match &inner.vault_dir {
            Some(vd) => vd.join("sidecar.sock"),
            None => return Err("vault is locked".to_string()),
        }
    };
    let params = serde_json::json!({
        "graphId": graph_id,
        "query": query,
        "k": k.unwrap_or(30),
    });
    ipc_client::request_with_timeout(
        &socket_path,
        "search.nodes",
        params,
        std::time::Duration::from_secs(15),
    )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn node_direct_edit(
    state: State<'_, AppState>,
    graph_id: String,
    node_id: String,
    content: String,
    reason: Option<String>,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match &inner.vault_dir {
            Some(vd) => vd.join("sidecar.sock"),
            None => return Err("vault is locked".to_string()),
        }
    };
    let mut params = serde_json::json!({
        "graphId": graph_id,
        "nodeId": node_id,
        "content": content,
    });
    if let Some(r) = reason {
        params["reason"] = serde_json::Value::String(r);
    }
    ipc_client::request_with_timeout(
        &socket_path,
        "node.directEdit",
        params,
        std::time::Duration::from_secs(30),
    )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn node_soft_delete(
    state: State<'_, AppState>,
    graph_id: String,
    node_id: String,
    reason: Option<String>,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match &inner.vault_dir {
            Some(vd) => vd.join("sidecar.sock"),
            None => return Err("vault is locked".to_string()),
        }
    };
    let mut params = serde_json::json!({
        "graphId": graph_id,
        "nodeId": node_id,
    });
    if let Some(r) = reason {
        params["reason"] = serde_json::Value::String(r);
    }
    ipc_client::request_with_timeout(
        &socket_path,
        "node.softDelete",
        params,
        std::time::Duration::from_secs(30),
    )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn node_link(
    state: State<'_, AppState>,
    graph_id: String,
    from_node_id: String,
    to_node_id: String,
    // Undirected edge type — defaults to `related-to` server-side if omitted.
    // Used by the App's typed-relationship picker for symmetric labels
    // (Same person, Same topic, Partners with, Related).
    r#type: Option<String>,
    reason: Option<String>,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match &inner.vault_dir {
            Some(vd) => vd.join("sidecar.sock"),
            None => return Err("vault is locked".to_string()),
        }
    };
    let mut params = serde_json::json!({
        "graphId": graph_id,
        "fromNodeId": from_node_id,
        "toNodeId": to_node_id,
    });
    if let Some(t) = r#type {
        params["type"] = serde_json::Value::String(t);
    }
    if let Some(r) = reason {
        params["reason"] = serde_json::Value::String(r);
    }
    ipc_client::request_with_timeout(
        &socket_path,
        "node.link",
        params,
        std::time::Duration::from_secs(30),
    )
        .await
        .map_err(|e| e.to_string())
}

/// Create a DIRECTED typed edge between two existing nodes. The Zod
/// schema on the sidecar side validates `type` against the SDK's
/// DirectedEdgeType enum; invalid types come back as an InvalidParams
/// error. `evidence` carries the user-friendly label (e.g. "Works at").
#[tauri::command]
async fn node_link_directed(
    state: State<'_, AppState>,
    graph_id: String,
    from_node_id: String,
    to_node_id: String,
    r#type: String,
    evidence: Option<String>,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match &inner.vault_dir {
            Some(vd) => vd.join("sidecar.sock"),
            None => return Err("vault is locked".to_string()),
        }
    };
    let mut params = serde_json::json!({
        "graphId": graph_id,
        "fromNodeId": from_node_id,
        "toNodeId": to_node_id,
        "type": r#type,
    });
    if let Some(e) = evidence {
        params["evidence"] = serde_json::Value::String(e);
    }
    ipc_client::request_with_timeout(
        &socket_path,
        "node.linkDirected",
        params,
        std::time::Duration::from_secs(30),
    )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_edges(
    state: State<'_, AppState>,
    graph_id: String,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match &inner.vault_dir {
            Some(vd) => vd.join("sidecar.sock"),
            None => return Err("vault is locked".to_string()),
        }
    };
    let params = serde_json::json!({ "graphId": graph_id });
    ipc_client::request_with_timeout(
        &socket_path,
        "edges.list",
        params,
        std::time::Duration::from_secs(30),
    )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_activity(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match &inner.vault_dir {
            Some(vd) => vd.join("sidecar.sock"),
            None => return Err("vault is locked".to_string()),
        }
    };
    // Decrypting the full op-log can take a few seconds on large vaults.
    ipc_client::request_with_timeout(
        &socket_path,
        "activity.list",
        serde_json::Value::Null,
        std::time::Duration::from_secs(60),
    )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_snapshots(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match &inner.vault_dir {
            Some(vd) => vd.join("sidecar.sock"),
            None => return Err("vault is locked".to_string()),
        }
    };
    ipc_client::request_with_timeout(
        &socket_path,
        "snapshots.list",
        serde_json::Value::Null,
        std::time::Duration::from_secs(30),
    )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_snapshot(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match &inner.vault_dir {
            Some(vd) => vd.join("sidecar.sock"),
            None => return Err("vault is locked".to_string()),
        }
    };
    // Copying every encrypted file in the vault — generous timeout for
    // large vaults with content cache enabled.
    ipc_client::request_with_timeout(
        &socket_path,
        "snapshots.create",
        serde_json::Value::Null,
        std::time::Duration::from_secs(300),
    )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_nodes(
    state: State<'_, AppState>,
    graph_id: String,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match &inner.vault_dir {
            Some(vd) => vd.join("sidecar.sock"),
            None => return Err("vault is locked".to_string()),
        }
    };
    let params = serde_json::json!({ "graphId": graph_id });
    ipc_client::request_with_timeout(
        &socket_path,
        "nodes.list",
        params,
        std::time::Duration::from_secs(30),
    )
        .await
        .map_err(|e| e.to_string())
}

/// Pending corrections proposed via the `correct` MCP tool but not yet
/// approved/rejected by the user. Held in-memory by the sidecar — they're
/// lost on lock/restart.
#[tauri::command]
async fn list_pending_corrections(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match &inner.vault_dir {
            Some(vd) => vd.join("sidecar.sock"),
            None => return Err("vault is locked".to_string()),
        }
    };
    ipc_client::request(&socket_path, "corrections.list", serde_json::Value::Null)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn apply_correction(
    state: State<'_, AppState>,
    diff_id: String,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match &inner.vault_dir {
            Some(vd) => vd.join("sidecar.sock"),
            None => return Err("vault is locked".to_string()),
        }
    };
    let params = serde_json::json!({ "diffId": diff_id });
    // Applying a correction touches the SDK, op-log, and embeddings — give
    // it 30s rather than the default 5.
    ipc_client::request_with_timeout(
        &socket_path,
        "corrections.apply",
        params,
        std::time::Duration::from_secs(30),
    )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn reject_correction(
    state: State<'_, AppState>,
    diff_id: String,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match &inner.vault_dir {
            Some(vd) => vd.join("sidecar.sock"),
            None => return Err("vault is locked".to_string()),
        }
    };
    let params = serde_json::json!({ "diffId": diff_id });
    ipc_client::request(&socket_path, "corrections.reject", params)
        .await
        .map_err(|e| e.to_string())
}

/// Bounce the sidecar's MCP socket listener. Closes the current server,
/// reopens at the same path. Used by the "Reconnect" button in the
/// inspector when the user thinks a client should be connected but isn't —
/// any client whose relay is in auto-reconnect-wait will connect on its
/// next probe; dead relays still need a client-side restart.
#[tauri::command]
async fn mcp_restart_listener(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match &inner.vault_dir {
            Some(vd) => vd.join("sidecar.sock"),
            None => return Err("vault is locked".to_string()),
        }
    };
    ipc_client::request_with_timeout(
        &socket_path,
        "mcp.restartListener",
        serde_json::Value::Null,
        std::time::Duration::from_secs(10),
    )
        .await
        .map_err(|e| e.to_string())
}

/// List the AI clients (Claude Desktop, Cursor, etc.) currently connected
/// to this App's sidecar over MCP. Used by the inspector's "Connected AI
/// clients" panel.
#[tauri::command]
async fn mcp_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match &inner.vault_dir {
            Some(vd) => vd.join("sidecar.sock"),
            None => return Err("vault is locked".to_string()),
        }
    };
    ipc_client::request(&socket_path, "mcp.status", serde_json::Value::Null)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn forget_source(
    state: State<'_, AppState>,
    graph_id: String,
    source_id: String,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match &inner.vault_dir {
            Some(vd) => vd.join("sidecar.sock"),
            None => return Err("vault is locked".to_string()),
        }
    };
    let params = serde_json::json!({ "graphId": graph_id, "sourceId": source_id });
    // Soft-deleting N nodes + saving the encrypted graph can take a few
    // seconds for big sources; 60s ceiling.
    ipc_client::request_with_timeout(
        &socket_path,
        "sources.forget",
        params,
        std::time::Duration::from_secs(60),
    )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match &inner.vault_dir {
            Some(vd) => vd.join("sidecar.sock"),
            None => return Err("vault is locked".to_string()),
        }
    };
    ipc_client::request(&socket_path, "settings.get", serde_json::Value::Null)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn update_settings(
    state: State<'_, AppState>,
    settings: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match &inner.vault_dir {
            Some(vd) => vd.join("sidecar.sock"),
            None => return Err("vault is locked".to_string()),
        }
    };
    ipc_client::request(&socket_path, "settings.update", settings)
        .await
        .map_err(|e| e.to_string())
}

/// Inspect the encrypted op-log and return a recovery plan listing every
/// source ever ingested (minus those forgotten), annotated with whether
/// it's recoverable (file still on disk), already-present, file-missing,
/// or otherwise unrecoverable. Read-only: no side effects on the vault.
#[tauri::command]
async fn recovery_plan(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match &inner.vault_dir {
            Some(vd) => vd.join("sidecar.sock"),
            None => return Err("vault is locked".to_string()),
        }
    };
    // Decrypting + reducing a large op-log can take longer than the default
    // 5s budget — give it a minute.
    ipc_client::request_with_timeout(
        &socket_path,
        "recovery.plan",
        serde_json::Value::Null,
        std::time::Duration::from_secs(60),
    )
        .await
        .map_err(|e| e.to_string())
}

/// Apply the recovery plan: re-ingest the selected sources (or every
/// recoverable item when `source_ids` is None). Returns a per-item report
/// the UI can render.
#[tauri::command]
async fn recovery_apply(
    state: State<'_, AppState>,
    source_ids: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match &inner.vault_dir {
            Some(vd) => vd.join("sidecar.sock"),
            None => return Err("vault is locked".to_string()),
        }
    };
    let params = serde_json::json!({ "sourceIds": source_ids });
    // Re-ingesting many sources can run for minutes. 10-minute ceiling
    // is generous enough that a healthy session won't trip it, while
    // still catching a truly hung sidecar.
    ipc_client::request_with_timeout(
        &socket_path,
        "recovery.apply",
        params,
        std::time::Duration::from_secs(600),
    )
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
            ingest_file,
            pick_and_ingest_file,
            forget_source,
            purge_forgotten,
            mcp_status,
            mcp_restart_listener,
            list_pending_corrections,
            apply_correction,
            reject_correction,
            list_graphs_with_metadata,
            create_graph_with_template,
            search_nodes,
            list_nodes,
            list_edges,
            node_direct_edit,
            node_soft_delete,
            node_link,
            node_link_directed,
            list_activity,
            list_snapshots,
            create_snapshot,
            recovery_plan,
            recovery_apply,
            get_settings,
            update_settings,
            configure_claude_desktop,
            open_vault_in_finder,
            show_window,
        ])
        .setup(|app| {
            // Full-blown Mac app: regular activation so we get a Dock icon,
            // ⌘Tab participation, and the standard window-first experience.
            // Tray icon stays as an ambient status indicator and quick-action
            // surface — but the App's home is now the main window.
            #[cfg(target_os = "macos")]
            {
                let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
            }
            // Show the main window on startup. The user sees the unlock view
            // immediately; tray "Show" still works for re-showing after ⌘W.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
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
        .build(tauri::generate_context!())
        .expect("error while running Graphnosis")
        .run(|app_handle, event| {
            // Intercept every exit path (tray Quit, Cmd+Q, macOS App > Quit,
            // app.exit() from a command, etc.) and synchronously shut down
            // the sidecar. The tray Quit handler does this too, but Cmd+Q
            // bypasses it — without this hook the sidecar gets reparented
            // to launchd and lives on as an orphan.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let state = app_handle.state::<AppState>();
                tauri::async_runtime::block_on(async {
                    let handle = {
                        let mut inner = state.inner.lock().await;
                        inner.sidecar.take()
                    };
                    if let Some(h) = handle {
                        let _ = h.shutdown().await;
                    }
                });
            }
        });
}

