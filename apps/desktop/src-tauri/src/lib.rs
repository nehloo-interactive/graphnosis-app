//! Graphnosis menu-bar app entry point.
//!
//! Responsibilities:
//! - Tauri builder with the plugins we need
//! - Tray (menu-bar) icon + dropdown menu
//! - Commands invoked from the unlock / inspector UI
//! - Supervises the Node sidecar process (single-writer guaranteed by
//!   the sidecar's own cortex lock)

mod biometric;
mod event_stream;
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

/// Separate managed state for a pending auto-update (if any). Kept outside
/// `AppInner` (and outside the async Mutex) so the tray can read it
/// synchronously without awaiting the inner lock.
pub struct UpdateState {
    pub available_version: std::sync::Mutex<Option<String>>,
}

#[derive(Default)]
struct AppInner {
    cortex_dir: Option<PathBuf>,
    sidecar: Option<sidecar::SidecarHandle>,
    /// Long-lived task reading push-events from `<cortex>/events.sock`.
    /// Spawned on unlock; dropped/cancelled on lock or sidecar replacement.
    event_stream: Option<event_stream::EventStreamHandle>,
    /// True when the current session was unlocked via the 24-word recovery
    /// phrase (not the passphrase). This drives the post-recovery flow that
    /// offers the user a chance to set a new passphrase — the new
    /// `change_passphrase` call goes through with `skipOldPassphraseCheck`
    /// because the user can't be expected to also know the forgotten old one.
    unlocked_via_recovery: bool,
}

#[derive(Serialize, Deserialize)]
pub struct UnlockArgs {
    pub cortex_dir: String,
    pub passphrase: String,
    /// User's last-active engram from localStorage. Tells the sidecar which
    /// engram to load FIRST (during "Loading memories…") so the lock screen
    /// disappears with the right engram already showing — instead of always
    /// loading "personal" first and then swapping mid-session.
    #[serde(default)]
    pub preferred_default_graph: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct RecoveryUnlockArgs {
    pub cortex_dir: String,
    pub recovery_phrase: String,
    #[serde(default)]
    pub preferred_default_graph: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct StatusSnapshot {
    pub unlocked: bool,
    pub cortex_dir: Option<String>,
    pub sidecar_running: bool,
}

// ---------- commands -----------------------------------------------------

#[tauri::command]
async fn pick_cortex_folder(app: AppHandle) -> Result<Option<String>, String> {
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
async fn unlock_cortex(
    app: AppHandle,
    state: State<'_, AppState>,
    args: UnlockArgs,
) -> Result<StatusSnapshot, String> {
    let cortex_dir = PathBuf::from(&args.cortex_dir);
    if !cortex_dir.is_dir() {
        return Err(format!("cortex folder does not exist: {}", args.cortex_dir));
    }

    // Persist the passphrase locally so subsequent launches can offer
    // Touch ID unlock without re-prompting for the passphrase. We log on
    // failure only; successful writes are routine and don't need stderr.
    if let Err(e) = keychain::store_passphrase(&args.cortex_dir, &args.passphrase) {
        eprintln!("[unlock_cortex] could not store passphrase for Touch ID: {:#}", e);
        return Err(e.to_string());
    }

    // Spawn the supervised Node sidecar. The sidecar acquires an exclusive
    // cortex lock on its own, so if another sidecar is already running against
    // the same cortex, this call will fail visibly.
    let handle = sidecar::start(&app, &cortex_dir, &args.passphrase, args.preferred_default_graph.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    {
        let mut inner = state.inner.lock().await;
        // If we had a previous sidecar running for a different cortex, kill it cleanly.
        if let Some(prev) = inner.sidecar.take() {
            let _ = prev.shutdown().await;
        }
        // Tear down the prior event stream (different cortex → different
        // socket). The new stream is spawned just below.
        if let Some(prev) = inner.event_stream.take() {
            prev.shutdown().await;
        }
        inner.cortex_dir = Some(cortex_dir.clone());
        let events_path = handle.events_socket_path.clone();
        inner.sidecar = Some(handle);
        inner.unlocked_via_recovery = false;
        // Spawn the push-event reader for this cortex. It tolerates the
        // sidecar's events socket not being up yet — bounded backoff
        // retries until either it connects or cortex lock cancels it.
        inner.event_stream = Some(event_stream::spawn(app.clone(), events_path));
    }

    // First-run detection: the sidecar writes `.recovery-pending` with the
    // plaintext 24-word phrase when it creates a brand-new cortex (or backfills
    // a legacy one). Read it, delete it, and emit `graphnosis://cortex-created`
    // so the webview can show the one-time recovery phrase modal.
    //
    // Event name uses a HYPHEN, not a dot — Tauri 2's event-name validator
    // rejects '.' (allowed: alphanumeric, '-', '/', ':', '_'). Emitting a
    // dotted name silently fails. Same applies to all forwarded events; see
    // event_stream.rs for the conversion logic.
    //
    // Diagnostics: every path through this block is logged. If a user reports
    // "the modal never showed", this is the first place to look. If the file
    // exists, the read happens; if the read fails, we keep the file on disk
    // for retry. The emit is wrapped so we know whether Tauri accepted it.
    let pending_path = cortex_dir.join(".recovery-pending");
    match std::fs::read_to_string(&pending_path) {
        Ok(phrase) => {
            let phrase = phrase.trim().to_string();
            if phrase.is_empty() {
                // Sidecar wrote an empty file — drop it, nothing to surface.
                let _ = std::fs::remove_file(&pending_path);
            } else {
                match app.emit("graphnosis://cortex-created", phrase.clone()) {
                    Ok(()) => {
                        // Only delete the pending file AFTER a successful
                        // emit. If emit failed, the file stays so the next
                        // unlock retries.
                        let _ = std::fs::remove_file(&pending_path);
                    }
                    Err(e) => {
                        eprintln!(
                            "[unlock] could not emit recovery-phrase event: {} — \
                             leaving pending file for next launch",
                            e
                        );
                    }
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Normal case: no pending phrase to show.
        }
        Err(e) => {
            eprintln!("[unlock] could not read pending recovery file: {}", e);
        }
    }

    let snapshot = current_status(&state).await;
    let _ = app.emit("graphnosis://status", &snapshot);
    tray::refresh_status(&app, &snapshot);
    Ok(snapshot)
}

/// Unlock the cortex using the 24-word BIP-39 recovery phrase instead of the
/// passphrase. Used when the user has forgotten their passphrase.
/// Does NOT persist anything to the keychain — this is an emergency access
/// path; the user should set a new passphrase or change their workflow after recovery.
#[tauri::command]
async fn unlock_cortex_with_recovery(
    app: AppHandle,
    state: State<'_, AppState>,
    args: RecoveryUnlockArgs,
) -> Result<StatusSnapshot, String> {
    let cortex_dir = PathBuf::from(&args.cortex_dir);
    if !cortex_dir.is_dir() {
        return Err(format!("cortex folder does not exist: {}", args.cortex_dir));
    }
    // Validate the cortex has a recovery.enc before spawning the sidecar.
    if !cortex_dir.join("recovery.enc").exists() {
        return Err(
            "No recovery.enc found in this cortex folder. \
             Recovery is only available for cortexes created with Graphnosis v0.2.x or later."
                .to_string(),
        );
    }

    let handle = sidecar::start_with_recovery(&app, &cortex_dir, &args.recovery_phrase, args.preferred_default_graph.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    {
        let mut inner = state.inner.lock().await;
        if let Some(prev) = inner.sidecar.take() {
            let _ = prev.shutdown().await;
        }
        if let Some(prev) = inner.event_stream.take() {
            prev.shutdown().await;
        }
        inner.cortex_dir = Some(cortex_dir.clone());
        let events_path = handle.events_socket_path.clone();
        inner.sidecar = Some(handle);
        inner.unlocked_via_recovery = true;
        inner.event_stream = Some(event_stream::spawn(app.clone(), events_path));
    }

    let snapshot = current_status(&state).await;
    let _ = app.emit("graphnosis://status", &snapshot);
    // Tell the frontend this session was unlocked via recovery so it can
    // surface the "Set a new passphrase?" modal.
    let _ = app.emit("graphnosis://unlocked-via-recovery", ());
    tray::refresh_status(&app, &snapshot);
    Ok(snapshot)
}

/// Suggest a sensible default cortex-folder path for a brand-new user
/// (`~/GraphnosisCortex`). The folder doesn't need to exist yet — the
/// Returns true when the given path exists as a directory on disk.
/// Called by the lock screen immediately after pre-filling the last-used
/// cortex path so it can warn the user before they attempt to unlock.
#[tauri::command]
async fn check_path_exists(path: String) -> bool {
    std::path::Path::new(&path).is_dir()
}

/// lock screen offers to create it on first unlock via `create_cortex_dir`.
/// Used by the lock screen to pre-fill the cortex-folder input when the
/// user hasn't picked one before.
#[tauri::command]
async fn suggest_cortex_path() -> Result<String, String> {
    let home = dirs::home_dir().ok_or_else(|| "could not resolve home directory".to_string())?;
    Ok(home.join("GraphnosisCortex").to_string_lossy().to_string())
}

/// Create a cortex folder at the given path (and any missing parents).
///
/// Idempotent: if the folder already exists it returns Ok immediately.
/// Errors only on real filesystem failures (permission denied, path
/// component is a file, etc.) — those bubble to the frontend so the user
/// sees the specific reason instead of a generic "unlock failed."
///
/// Called by the frontend after the unlock click hits "cortex folder does
/// not exist" and the user confirms creation. We deliberately don't
/// auto-create on every unlock — making folder creation an explicit
/// user decision avoids the trap where a typo'd path silently materialises
/// a new empty cortex.
#[tauri::command]
async fn create_cortex_dir(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if p.exists() {
        if p.is_dir() {
            return Ok(());
        }
        return Err(format!("'{}' exists but is not a directory", path));
    }
    std::fs::create_dir_all(p)
        .map_err(|e| format!("Could not create '{}': {}", path, e))
}

/// Reports whether the lock screen should offer a Touch ID button for the
/// given cortex. Two preconditions:
///   1. Biometric hardware is present + the user has at least one enrolled
///      fingerprint (checked by spawning the Swift sidecar in --check mode).
///   2. We have a stored passphrase for this cortex in the macOS Keychain.
///      Without that, biometric auth has nothing to unlock — the user
///      hasn't completed a passphrase login on this machine yet.
///
/// Returning false is the silent fallback: the frontend hides the button
/// and the user uses the passphrase field as normal.
#[tauri::command]
async fn biometric_available(
    app: AppHandle,
    cortex_dir: String,
) -> Result<bool, String> {
    let has_passphrase = keychain::load_passphrase(&cortex_dir)
        .map_err(|e| e.to_string())?
        .is_some();
    if !has_passphrase {
        return Ok(false);
    }
    Ok(biometric::is_available(&app).await)
}

/// Unlock the cortex via Touch ID. Triggers the macOS biometric prompt
/// (via the Swift sidecar); on success, reads the stored passphrase from
/// the Keychain and delegates to the regular `unlock_cortex` flow.
#[tauri::command]
async fn biometric_unlock(
    app: AppHandle,
    state: State<'_, AppState>,
    cortex_dir: String,
    preferred_default_graph: Option<String>,
) -> Result<StatusSnapshot, String> {
    let ok = biometric::prompt(&app, "Unlock your Graphnosis cortex")
        .await
        .map_err(|e| e.to_string())?;
    if !ok {
        return Err("biometric authentication cancelled".to_string());
    }
    let passphrase = keychain::load_passphrase(&cortex_dir)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no saved passphrase for this cortex".to_string())?;
    let args = UnlockArgs { cortex_dir, passphrase, preferred_default_graph };
    unlock_cortex(app, state, args).await
}

#[derive(Serialize, Deserialize)]
pub struct ChangePassphraseArgs {
    pub new_passphrase: String,
    /// Required for "I remember my old passphrase and want to rotate it"
    /// flow. Omitted when the current session is unlocked via recovery
    /// phrase (the sidecar will skip the old-passphrase check in that case,
    /// driven by `inner.unlocked_via_recovery`).
    pub old_passphrase: Option<String>,
}

/// Rewrap master.enc with a key derived from `new_passphrase`. The data key
/// — and every encrypted file in the cortex — is unchanged. Recovery phrase
/// remains valid. On success, the new passphrase is also written to the
/// macOS Keychain so the app auto-unlocks with it on subsequent launches.
#[tauri::command]
async fn change_passphrase(
    state: State<'_, AppState>,
    args: ChangePassphraseArgs,
) -> Result<serde_json::Value, String> {
    let (socket_path, cortex_dir, skip_old_check) = {
        let inner = state.inner.lock().await;
        let socket_path = inner.sidecar.as_ref()
            .map(|h| h.socket_path.clone())
            .ok_or_else(|| "cortex is locked".to_string())?;
        let cd = inner.cortex_dir.clone()
            .ok_or_else(|| "cortex is locked".to_string())?;
        (socket_path, cd, inner.unlocked_via_recovery)
    };

    // If we're not in a recovery session, the user must supply the old
    // passphrase. Refuse rather than silently skipping the check.
    if !skip_old_check && args.old_passphrase.is_none() {
        return Err(
            "old_passphrase is required when not unlocked via recovery phrase"
                .to_string(),
        );
    }

    let mut params = serde_json::json!({
        "newPassphrase": args.new_passphrase,
    });
    if skip_old_check {
        params["skipOldPassphraseCheck"] = serde_json::Value::Bool(true);
    } else if let Some(op) = &args.old_passphrase {
        params["oldPassphrase"] = serde_json::Value::String(op.clone());
    }

    let result = ipc_client::request_with_timeout(
        &socket_path,
        "passphrase.change",
        params,
        std::time::Duration::from_secs(60),
    )
        .await
        .map_err(|e| e.to_string())?;

    // Update the macOS Keychain so future auto-unlocks use the new passphrase.
    // Failure here is non-fatal — the rotation already succeeded on disk —
    // but we surface it as a warning so the user knows they may be prompted
    // on next launch instead of auto-unlocked.
    let keychain_ok = keychain::store_passphrase(
        &cortex_dir.to_string_lossy(),
        &args.new_passphrase,
    ).is_ok();

    // Clear the recovery-session flag — the user has now set a real
    // passphrase, future passphrase changes should require the old one.
    {
        let mut inner = state.inner.lock().await;
        inner.unlocked_via_recovery = false;
    }

    let mut out = result;
    if let Some(obj) = out.as_object_mut() {
        obj.insert(
            "keychainUpdated".to_string(),
            serde_json::Value::Bool(keychain_ok),
        );
    }
    Ok(out)
}

/// Generate a fresh 24-word recovery phrase, replacing the existing
/// `recovery.enc`. Returns the new phrase as a string so the frontend can
/// show it once (then never again — same modal as first-run).
///
/// The data key is preserved; only the wrapper changes.
#[tauri::command]
async fn regenerate_recovery_phrase(state: State<'_, AppState>) -> Result<String, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
        }
    };
    let result = ipc_client::request_with_timeout(
        &socket_path,
        "recoveryPhrase.regenerate",
        serde_json::Value::Null,
        std::time::Duration::from_secs(15),
    )
        .await
        .map_err(|e| e.to_string())?;
    // Extract `recoveryPhrase` from the response object.
    result
        .get("recoveryPhrase")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "sidecar response missing recoveryPhrase".to_string())
}

/// List every quarantined `.gai.corrupt-<ts>` / `.bundle.corrupt-<ts>` file
/// in the cortex's `graphs/` directory. Used by the Settings → Quarantine
/// section so the user can review and decide whether to delete or restore.
#[tauri::command]
async fn list_quarantine(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    // Implemented in Rust directly (reads the filesystem) so it works even
    // when the Node sidecar's event loop is blocked by an ONNX embedding pass.
    // The sidecar's quarantine.list IPC had a 15s timeout that fired whenever
    // an ingest was in progress — this path has no timeout at all.
    let cortex_dir = {
        let inner = state.inner.lock().await;
        match inner.cortex_dir.as_ref() {
            Some(d) => d.clone(),
            None => return Err("cortex is locked".to_string()),
        }
    };

    let graphs_dir = cortex_dir.join("graphs");

    // Read all live graph IDs (files named "<id>.gai").
    let mut live_ids = std::collections::HashSet::new();
    if let Ok(rd) = std::fs::read_dir(&graphs_dir) {
        for entry in rd.flatten() {
            let name = entry.file_name();
            let s = name.to_string_lossy();
            if let Some(stem) = s.strip_suffix(".gai") {
                if !stem.contains('.') {
                    live_ids.insert(stem.to_string());
                }
            }
        }
    }

    // Manual match: "<engramId>.<gai|bundle>.corrupt-<digits>"
    // We look for the last occurrence of either ".gai.corrupt-" or
    // ".bundle.corrupt-" so that engram IDs containing dots still work.
    let mut items: Vec<serde_json::Value> = vec![];
    if let Ok(rd) = std::fs::read_dir(&graphs_dir) {
        for entry in rd.flatten() {
            let name = entry.file_name();
            let s = name.to_string_lossy().to_string();

            // Determine which suffix marker is present and where.
            let parsed = if let Some(pos) = s.rfind(".gai.corrupt-") {
                let ts_part = &s[pos + ".gai.corrupt-".len()..];
                if ts_part.chars().all(|c| c.is_ascii_digit()) && !ts_part.is_empty() {
                    Some((&s[..pos], "gai", ts_part))
                } else { None }
            } else if let Some(pos) = s.rfind(".bundle.corrupt-") {
                let ts_part = &s[pos + ".bundle.corrupt-".len()..];
                if ts_part.chars().all(|c| c.is_ascii_digit()) && !ts_part.is_empty() {
                    Some((&s[..pos], "bundle", ts_part))
                } else { None }
            } else { None };

            if let Some((engram_id, kind, ts_str)) = parsed {
                let timestamp: u64 = ts_str.parse().unwrap_or(0);
                let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
                let live_engram_exists = live_ids.contains(engram_id);
                items.push(serde_json::json!({
                    "name":             s,
                    "engramId":         engram_id,
                    "kind":             kind,
                    "timestamp":        timestamp,
                    "sizeBytes":        size_bytes,
                    "liveEngramExists": live_engram_exists,
                }));
            }
        }
    }

    // Sort newest-first by timestamp.
    items.sort_by(|a, b| {
        let ta = a["timestamp"].as_u64().unwrap_or(0);
        let tb = b["timestamp"].as_u64().unwrap_or(0);
        tb.cmp(&ta)
    });

    Ok(serde_json::json!({ "items": items }))
}

/// Permanently delete one quarantined file. The frontend is responsible for
/// confirmation UX (typed match); the sidecar enforces a name-shape regex
/// so this can't be abused to delete arbitrary cortex files.
#[tauri::command]
async fn delete_quarantine(
    state: State<'_, AppState>,
    name: String,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
        }
    };
    ipc_client::request_with_timeout(
        &socket_path,
        "quarantine.delete",
        serde_json::json!({ "name": name }),
        std::time::Duration::from_secs(15),
    )
        .await
        .map_err(|e| e.to_string())
}

/// Restore a quarantined file to its canonical name. Used when the user
/// believes the quarantine was spurious. Refuses if a current file with
/// the same canonical name already exists.
#[tauri::command]
async fn restore_quarantine(
    state: State<'_, AppState>,
    name: String,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
        }
    };
    ipc_client::request_with_timeout(
        &socket_path,
        "quarantine.restore",
        serde_json::json!({ "name": name }),
        std::time::Duration::from_secs(15),
    )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn lock_cortex(app: AppHandle, state: State<'_, AppState>) -> Result<StatusSnapshot, String> {
    {
        let mut inner = state.inner.lock().await;
        if let Some(handle) = inner.sidecar.take() {
            let _ = handle.shutdown().await;
        }
        if let Some(stream) = inner.event_stream.take() {
            stream.shutdown().await;
        }
    }
    // NOTE: we deliberately do NOT clear the cached passphrase here. Lock
    // means "step away" not "forget everything"; if we delete the cached
    // passphrase on lock, Touch ID unlock has nothing to read on the next
    // visit to the lock screen — defeating the whole point of storing it.
    // The cache is only cleared when:
    //   - The user explicitly changes the passphrase (passphrase rotation
    //     replaces the cache on success)
    //   - The user disables Touch ID for this cortex (future Settings flow)
    //   - The user deletes the cortex (also a future flow)
    // For now: persist until one of those happens.
    let snapshot = StatusSnapshot {
        unlocked: false,
        cortex_dir: None,
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

/// Reconciliation cursor — {graphId: lastMutationTs} for all loaded graphs.
/// The frontend polls this on a slow interval (~30s) as a safety net for
/// the push-event channel; if a push frame got dropped (backpressure,
/// reconnect mid-mutation), this catches the drift on the next tick.
#[tauri::command]
async fn node_cursor(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
        }
    };
    ipc_client::request_with_timeout(
        &socket_path,
        "node.cursor",
        serde_json::Value::Null,
        std::time::Duration::from_secs(5),
    )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn inspector_stats(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
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
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
        }
    };
    let params = serde_json::json!({
        "graphId": graph_id.unwrap_or_else(|| "personal".to_string()),
        "path": path,
    });
    // PDF parse + embeddings build + encrypted save can take well over 5s
    // on first ingest (BGE model warm-up). Large PDFs (100+ pages) can
    // saturate the embedding pipeline for several minutes. 600s (10 min)
    // covers even the largest realistic documents.
    ipc_client::request_with_timeout(
        &socket_path,
        "ingest.file",
        params,
        std::time::Duration::from_secs(600),
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

/// Multi-file native picker. Returns the chosen file paths so the
/// frontend can iterate ingest sequentially with one progress toast per
/// file. We deliberately don't ingest here — the frontend wants per-file
/// progress feedback, which requires the round-trip to happen in JS
/// (sequential `ingest_file` invokes, each with its own toast).
///
/// Empty result = user cancelled (or selected nothing).
/// Let the user pick one or more folders via the native OS dialog.
/// Empty result = user cancelled.
#[tauri::command]
async fn pick_folders(app: AppHandle) -> Result<Vec<String>, String> {
    // Tauri v2 blocking_pick_folders opens a multi-select folder dialog.
    let picked = app
        .dialog()
        .file()
        .set_title("Choose project folders to watch")
        .blocking_pick_folders();
    let paths = match picked {
        Some(folders) => folders
            .into_iter()
            .filter_map(|f| f.into_path().ok())
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
        None => Vec::new(),
    };
    Ok(paths)
}

#[tauri::command]
async fn pick_files(app: AppHandle) -> Result<Vec<String>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Choose files to ingest into Graphnosis")
        .add_filter("Common ingestible formats", &["md", "markdown", "txt", "html", "htm", "json", "csv", "pdf", "docx"])
        .blocking_pick_files();
    let paths = match picked {
        Some(files) => files
            .into_iter()
            .filter_map(|f| f.into_path().ok())
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
        None => Vec::new(),
    };
    Ok(paths)
}

/// Result of an MCP-client configure flow. The UI shows the user what
/// changed so they know exactly what was written.
///
/// Kept name `ClaudeConfigResult` for now to avoid churn on the JS-side
/// type, but the result now covers any client — see `client_name` /
/// `restart_hint` for per-client surface.
#[derive(Serialize)]
struct ClaudeConfigResult {
    /// Display name of the configured client (e.g. "Claude Desktop").
    client_name: String,
    /// One-sentence "restart X so it re-reads the config" instruction,
    /// rendered in the modal footer.
    restart_hint: String,
    config_path: String,
    relay_path: String,
    /// Empty string — kept in the payload for backward compatibility with
    /// older frontend versions that still read it. Post-Bun the relay is a
    /// self-contained binary and clients don't need a separate Node path.
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
/// Identifier for one of the MCP-aware client apps we can auto-configure.
/// Add a new variant + `display_name` + `config_path` entry to wire a new
/// client. Every supported client uses the same `mcpServers` shape — only
/// the config file location differs — so this is a flat enum, not a trait.
#[derive(Debug, Clone, Copy)]
enum McpClient {
    /// Anthropic's macOS desktop app. Config at
    /// `~/Library/Application Support/Claude/claude_desktop_config.json`.
    ClaudeDesktop,
    /// `claude` CLI (Claude Code). User-level config at `~/.claude.json`
    /// with the same `mcpServers` shape. The CLI also supports project-
    /// scoped `.mcp.json` files but we write to the user level so it
    /// works regardless of CWD.
    ClaudeCode,
    /// Cursor IDE. User-level config at `~/.cursor/mcp.json`.
    Cursor,
}

impl McpClient {
    fn from_id(id: &str) -> Option<Self> {
        match id {
            "claude-desktop" => Some(Self::ClaudeDesktop),
            "claude-code" => Some(Self::ClaudeCode),
            "cursor" => Some(Self::Cursor),
            _ => None,
        }
    }
    fn display_name(&self) -> &'static str {
        match self {
            Self::ClaudeDesktop => "Claude Desktop",
            Self::ClaudeCode => "Claude Code",
            Self::Cursor => "Cursor",
        }
    }
    /// User-visible "after applying, restart X" hint shown in the modal
    /// footer. Most clients need a full quit + reopen to re-read the
    /// MCP config; some (like Cursor) reload on workspace open.
    fn restart_hint(&self) -> &'static str {
        match self {
            Self::ClaudeDesktop => "Fully quit Claude Desktop (⌘Q) and reopen it.",
            Self::ClaudeCode => "Restart any running `claude` CLI sessions to pick up the new MCP server.",
            Self::Cursor => "Reopen Cursor (or restart the workspace) so it re-reads ~/.cursor/mcp.json.",
        }
    }
}

/// Configure an MCP-aware AI client to talk to this App's running sidecar.
///
/// Writes an `mcpServers.Graphnosis` entry to the client's config file,
/// pointing it at the compiled relay binary + the fixed MCP socket
/// (`~/.graphnosis/mcp.sock` — cortex-independent, so one "Connect" survives
/// every cortex switch). Preserves any other MCP servers the user had.
///
/// Adding a new client: extend `McpClient` with a variant, add the OS-
/// specific path branch in `mcp_client_config_path`, and add a button
/// in the Settings UI calling `configure_mcp_client(<new-id>)`.
#[tauri::command]
async fn configure_mcp_client(
    state: State<'_, AppState>,
    client_id: String,
) -> Result<ClaudeConfigResult, String> {
    let client = McpClient::from_id(&client_id)
        .ok_or_else(|| format!("Unknown AI client id: '{}'", client_id))?;

    // Graphnosis must be unlocked — the sidecar (and its MCP listener) only
    // runs while a cortex is open, so there is nothing to attach to otherwise.
    {
        let inner = state.inner.lock().await;
        if inner.cortex_dir.is_none() {
            return Err(format!(
                "Unlock Graphnosis first — {} connects to the running app.",
                client.display_name(),
            ));
        }
    }

    // The MCP socket lives at a FIXED, cortex-independent path. The client
    // config written below is global; baking a per-cortex path into it (the
    // old behavior) silently broke the connection the moment the user opened
    // a different cortex folder.
    let socket_path = sidecar::mcp_socket_path().map_err(|e| e.to_string())?;

    // Resolve the compiled MCP relay binary. Same one all clients spawn —
    // the relay is a self-contained executable with the socket path as
    // argv[1], no Node dependency on the user's machine.
    let relay = sidecar::resolve_relay_path().map_err(|e| e.to_string())?;

    let config_path = mcp_client_config_path(client).ok_or_else(|| {
        format!(
            "Could not locate {}'s config directory for this user. \
             This OS isn't supported yet for that client.",
            client.display_name(),
        )
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
        return Err(format!(
            "{} root is not a JSON object — aborting. Fix or remove the file and try again.",
            config_path.display(),
        ));
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
    // The relay binary is the command; the socket path is argv[1].
    let desired_entry = serde_json::json!({
        "command": relay.to_string_lossy(),
        "args": [
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
        client_name: client.display_name().to_string(),
        restart_hint: client.restart_hint().to_string(),
        config_path: config_path.to_string_lossy().into_owned(),
        relay_path: relay.to_string_lossy().into_owned(),
        node_path: String::new(),
        socket_path: socket_path.to_string_lossy().into_owned(),
        already_configured,
        created_file,
        preserved_servers,
    })
}

/// Where each supported MCP client stores its config on this OS.
///
/// macOS paths are the upstream-documented locations:
///   - Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json`
///   - Claude Code:    `~/.claude.json` (user-level; CLI also supports
///                     project-scoped `.mcp.json` we don't touch)
///   - Cursor:         `~/.cursor/mcp.json` (user-level)
///
/// Windows mirrors macOS for the dotfile-based clients (Claude Code and
/// Cursor both use `%USERPROFILE%\<dotfile>` on every platform) and uses
/// `%APPDATA%\Claude\` for Claude Desktop — Anthropic's documented Windows
/// location, equivalent to macOS's Application Support folder.
///
/// Linux is still unsupported (Claude Desktop isn't officially distributed
/// for Linux) — the command surfaces a clear "not supported yet" error
/// when this returns None.
#[cfg(target_os = "macos")]
fn mcp_client_config_path(client: McpClient) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    Some(match client {
        McpClient::ClaudeDesktop => home
            .join("Library")
            .join("Application Support")
            .join("Claude")
            .join("claude_desktop_config.json"),
        McpClient::ClaudeCode => home.join(".claude.json"),
        McpClient::Cursor => home.join(".cursor").join("mcp.json"),
    })
}

#[cfg(target_os = "windows")]
fn mcp_client_config_path(client: McpClient) -> Option<PathBuf> {
    Some(match client {
        // Claude Desktop on Windows ships in two installer formats and the
        // config file lives in a different place depending on which the user
        // has installed:
        //   1. Microsoft Store / MSIX packaged app (most users — what
        //      claude.ai/download serves). Sandbox-redirects %APPDATA% to
        //      %LOCALAPPDATA%\Packages\Claude_<publisher-hash>\LocalCache\
        //      Roaming\Claude\. The legacy %APPDATA%\Claude\ file is
        //      invisible to the packaged app.
        //   2. Legacy MSI installer (older / enterprise installs). Config at
        //      the standard %APPDATA%\Claude\ location.
        // Helper probes for the packaged-app folder first and falls back to
        // the MSI path when no Claude_* package is installed. Writing to the
        // wrong one is silently broken — Claude reads only the path matching
        // its install kind.
        McpClient::ClaudeDesktop => windows_claude_desktop_config_path()?,
        // Claude Code and Cursor both use a dotfile in the user's home
        // directory on every platform, so the path shape matches macOS —
        // dirs::home_dir() returns %USERPROFILE% on Windows.
        McpClient::ClaudeCode => dirs::home_dir()?.join(".claude.json"),
        McpClient::Cursor => dirs::home_dir()?.join(".cursor").join("mcp.json"),
    })
}

/// Resolve the Claude Desktop config-file path on Windows, accounting for
/// the Store/MSIX packaged-app sandbox redirection. See callsite for the
/// background — `Packages\Claude_*` only exists when Claude was installed
/// from the Microsoft Store, so its presence is the deciding signal.
#[cfg(target_os = "windows")]
fn windows_claude_desktop_config_path() -> Option<PathBuf> {
    let local_appdata = dirs::data_local_dir()?;
    let packages = local_appdata.join("Packages");
    if let Ok(entries) = std::fs::read_dir(&packages) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let n = name.to_string_lossy();
            if n.starts_with("Claude_") && entry.path().is_dir() {
                return Some(
                    entry.path()
                        .join("LocalCache")
                        .join("Roaming")
                        .join("Claude")
                        .join("claude_desktop_config.json"),
                );
            }
        }
    }
    // Fall back to legacy MSI install path. dirs::config_dir() returns
    // %APPDATA% (= C:\Users\<user>\AppData\Roaming) on Windows.
    Some(dirs::config_dir()?.join("Claude").join("claude_desktop_config.json"))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn mcp_client_config_path(_client: McpClient) -> Option<PathBuf> {
    // TODO: wire up Linux paths when that build ships.
    None
}

/// Physically remove every soft-deleted node from a graph by rebuilding it
/// from the surviving live sources. Slow — up to a few minutes on big cortexes.
#[tauri::command]
async fn purge_forgotten(
    state: State<'_, AppState>,
    graph_id: String,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
        }
    };
    let params = serde_json::json!({ "graphId": graph_id });
    ipc_client::request_with_timeout(
        &socket_path,
        "cortex.purgeForgotten",
        params,
        std::time::Duration::from_secs(600),
    )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_graphs_with_metadata(
    state: State<'_, AppState>,
    include_unloaded: Option<bool>,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
        }
    };
    let params = serde_json::json!({ "includeUnloaded": include_unloaded.unwrap_or(false) });
    ipc_client::request(&socket_path, "graphs.listWithMetadata", params)
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
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
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

/// One-shot accept the "Create engram?" suggestion banner.
///
/// The flow upstream:
///   1. AI calls `remember(text, target_engram="book-notes")` via MCP.
///   2. Sidecar can't resolve the target — broadcasts `engram.create-suggested`
///      to the event socket AND returns an actionable error to the AI.
///   3. App UI shows a banner with the AI's note. User clicks "Create".
///   4. This Tauri command fires, which calls the sidecar's
///      `graphs.acceptEngramSuggestion` IPC. The sidecar creates the
///      engram (if it doesn't exist already — idempotent) and ingests
///      the suggested note into it. One roundtrip.
///   5. App refreshes its engram list + Sources tab — the user sees the
///      new engram with the note already inside.
///
/// Why a dedicated command (not "create_graph_with_template + ingest_*")?
/// Two reasons: (a) lets the sidecar enforce the "idempotent create" with
/// no race window, (b) keeps the UI handler simple — one button, one IPC,
/// one result toast. Splitting into two calls means the App has to manage
/// half-success states (engram created but ingest failed).
#[tauri::command]
async fn accept_engram_suggestion(
    state: State<'_, AppState>,
    graph_id: String,
    template: String,
    display_name: String,
    text: String,
    label: String,
    source_kind: Option<String>,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
        }
    };
    let mut params = serde_json::json!({
        "graphId": graph_id,
        "template": template,
        "displayName": display_name,
        "text": text,
        "label": label,
    });
    if let Some(sk) = source_kind {
        params["sourceKind"] = serde_json::Value::String(sk);
    }
    // Bigger budget than plain create — ingestClip runs through the
    // embedding pool (BGE inference for the new node's vector) and the
    // first call after a fresh engram creation cold-starts the pool.
    // 120 s is comfortably above the worst observed cold-start.
    ipc_client::request_with_timeout(
        &socket_path,
        "graphs.acceptEngramSuggestion",
        params,
        std::time::Duration::from_secs(120),
    )
        .await
        .map_err(|e| e.to_string())
}

/// Post a system notification for an engram-create-suggested event that
/// includes an **Accept** action button (macOS only).
///
/// On macOS the notification uses `mac-notification-sys` with
/// `MainButton::SingleAction("Accept")` so the user can approve the new
/// engram without opening the App. When they click Accept the Rust thread
/// emits `graphnosis://engram-notification-accepted`; the frontend listener
/// calls `accept_engram_suggestion` with the same payload.
///
/// On Windows / Linux there are no action buttons — a plain informational
/// notification is sent instead (user must open the App to act).
#[tauri::command]
async fn show_engram_action_notification(
    app: AppHandle,
    graph_id: String,
    template: String,
    display_name: String,
    text: String,
    label: String,
    source_kind: Option<String>,
    suggested_name: String,
    requested_by: Option<String>,
) -> Result<(), String> {
    let who = requested_by
        .as_deref()
        .unwrap_or("An AI client")
        .to_string();
    let notification_body = format!(
        "{} wants to save into a new engram \"{}\". Accept to create it.",
        who, suggested_name
    );

    #[cfg(target_os = "macos")]
    {
        let app_clone = app.clone();
        let body_owned = notification_body.clone();
        std::thread::spawn(move || {
            let result = mac_notification_sys::Notification::new()
                .title("Graphnosis — confirmation needed")
                .message(&body_owned)
                .main_button(mac_notification_sys::MainButton::SingleAction("Accept"))
                .wait_for_click(true)
                .send();
            match result {
                Ok(mac_notification_sys::NotificationResponse::ActionButton(_)) => {
                    // User clicked Accept — emit event; the frontend calls
                    // accept_engram_suggestion with the stored payload.
                    let payload = serde_json::json!({
                        "graphId": graph_id,
                        "template": template,
                        "displayName": display_name,
                        "text": text,
                        "label": label,
                        "sourceKind": source_kind,
                    });
                    let _ = app_clone.emit(
                        "graphnosis://engram-notification-accepted",
                        payload,
                    );
                }
                Ok(mac_notification_sys::NotificationResponse::Click) => {
                    // Notification body click — bring the window up so the
                    // in-app banner is visible.
                    if let Some(win) = app_clone.get_webview_window("main") {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
                _ => {}
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        // No action buttons on Windows / Linux — plain notification; user
        // opens the App to act on the in-app banner.
        use tauri_plugin_notification::NotificationExt;
        let _ = app
            .notification()
            .builder()
            .title("Graphnosis — confirmation needed")
            .body(&notification_body)
            .show();
    }

    Ok(())
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
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
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
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
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
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
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
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
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
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
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

/// Remove a single edge by its SDK edge id. Used by the App's
/// "change type" button — it unlinks the old edge then re-links with
/// the new type so both don't linger simultaneously. Returns
/// `{ removed: bool, wasDirected?: bool }` from the sidecar.
#[tauri::command]
async fn node_unlink(
    state: State<'_, AppState>,
    graph_id: String,
    edge_id: String,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
        }
    };
    let params = serde_json::json!({
        "graphId": graph_id,
        "edgeId": edge_id,
    });
    ipc_client::request_with_timeout(
        &socket_path,
        "node.unlink",
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
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
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
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
        }
    };
    // Decrypting the full op-log can take a few seconds on large cortexes.
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
    // Implemented in Rust directly (reads the filesystem) so it works even
    // when the Node sidecar's event loop is blocked by an ONNX embedding pass.
    // The sidecar's snapshots.list IPC had a 30s timeout that fired whenever
    // an ingest was in progress — this path has no timeout at all.
    let cortex_dir = {
        let inner = state.inner.lock().await;
        match inner.cortex_dir.as_ref() {
            Some(d) => d.clone(),
            None => return Err("cortex is locked".to_string()),
        }
    };

    let snapshots_dir = cortex_dir.join(".snapshots");
    if !snapshots_dir.exists() {
        return Ok(serde_json::json!({ "snapshots": [] }));
    }

    let mut snapshots: Vec<serde_json::Value> = vec![];

    let rd = std::fs::read_dir(&snapshots_dir).map_err(|e| e.to_string())?;
    for entry in rd.flatten() {
        let name = entry.file_name();
        let id = name.to_string_lossy().to_string();
        if id.starts_with('.') {
            continue;
        }
        let full = entry.path();
        if !full.is_dir() {
            continue;
        }

        // Get creation time (fallback to mtime on platforms without birthtime).
        let created_at_ms = entry.metadata()
            .ok()
            .and_then(|m| {
                m.created()
                    .or_else(|_| m.modified())
                    .ok()
            })
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        // Walk the snapshot directory to accumulate size + file count.
        let mut size_bytes: u64 = 0;
        let mut file_count: u64 = 0;
        let mut stack = vec![full.clone()];
        while let Some(dir) = stack.pop() {
            if let Ok(children) = std::fs::read_dir(&dir) {
                for child in children.flatten() {
                    let cp = child.path();
                    if cp.is_dir() {
                        stack.push(cp);
                    } else if let Ok(meta) = child.metadata() {
                        size_bytes += meta.len();
                        file_count += 1;
                    }
                }
            }
        }

        snapshots.push(serde_json::json!({
            "id":         id,
            "createdAt":  created_at_ms,
            "sizeBytes":  size_bytes,
            "fileCount":  file_count,
        }));
    }

    // Sort newest-first.
    snapshots.sort_by(|a, b| {
        let ta = a["createdAt"].as_u64().unwrap_or(0);
        let tb = b["createdAt"].as_u64().unwrap_or(0);
        tb.cmp(&ta)
    });

    Ok(serde_json::json!({ "snapshots": snapshots }))
}

#[tauri::command]
async fn create_snapshot(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
        }
    };
    // Copying every encrypted file in the cortex — generous timeout for
    // large cortexes with content cache enabled.
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
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
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
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
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
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
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
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
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
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
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

/// Generic pass-through from the UI to the sidecar's IPC dispatch.
/// Used for brain/LLM methods that don't have dedicated Tauri commands.
/// Timeout is generous (120s) to accommodate slow LLM operations.
#[tauri::command]
async fn sidecar_ipc_call(
    state: State<'_, AppState>,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
        }
    };
    ipc_client::request_with_timeout(
        &socket_path,
        &method,
        params,
        // 300 s: covers docs:ingest (24 pages × ~5 s embedding each) plus
        // startup contention when other engrams are loading concurrently.
        // The previous 120 s limit was tight enough to fire on cold starts.
        std::time::Duration::from_secs(300),
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
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
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
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
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
async fn reingest_source(
    state: State<'_, AppState>,
    graph_id: String,
    source_id: String,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
        }
    };
    let params = serde_json::json!({ "graphId": graph_id, "sourceId": source_id });
    // Forget + fresh ingest is a sequential round-trip on the sidecar
    // side. PDF re-parse + BGE re-embed can hit the same multi-second
    // budget as the original ingest_file, so give it the same 180s.
    ipc_client::request_with_timeout(
        &socket_path,
        "sources.reingest",
        params,
        std::time::Duration::from_secs(180),
    )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
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
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
        }
    };
    ipc_client::request(&socket_path, "settings.update", settings)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_mobile_connection_info(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
        }
    };
    ipc_client::request_with_timeout(
        &socket_path,
        "mobile.getConnectionInfo",
        serde_json::Value::Null,
        std::time::Duration::from_secs(5),
    )
        .await
        .map_err(|e| e.to_string())
}

// ── Service connector commands ──────────────────────────────────────────────
//
// Five thin pass-throughs to the sidecar's connectors.* IPC. All take the
// same shape as get_mobile_connection_info: lock → grab socket → IPC call
// → map error. Each has a generous timeout because connector pulls can hit
// rate-limited external APIs (GitHub, Slack, Linear) that occasionally take
// 30+ seconds during a single iteration.

#[tauri::command]
async fn list_connectors(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
        }
    };
    ipc_client::request_with_timeout(
        &socket_path,
        "connectors.list",
        serde_json::Value::Null,
        std::time::Duration::from_secs(5),
    )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn install_connector(
    state: State<'_, AppState>,
    config: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
        }
    };
    ipc_client::request_with_timeout(
        &socket_path,
        "connectors.install",
        serde_json::json!({ "config": config }),
        std::time::Duration::from_secs(30),
    )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn remove_connector(
    state: State<'_, AppState>,
    id: String,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
        }
    };
    ipc_client::request_with_timeout(
        &socket_path,
        "connectors.remove",
        serde_json::json!({ "id": id }),
        std::time::Duration::from_secs(10),
    )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn trigger_connector_pull(
    state: State<'_, AppState>,
    id: String,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
        }
    };
    // Pulls hit external APIs and may need to embed dozens of new items —
    // 120s ceiling covers a healthy first-pull on GitHub/Slack workspaces.
    ipc_client::request_with_timeout(
        &socket_path,
        "connectors.triggerPull",
        serde_json::json!({ "id": id }),
        std::time::Duration::from_secs(120),
    )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_connector_auth_url(
    state: State<'_, AppState>,
    id: String,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
        }
    };
    ipc_client::request_with_timeout(
        &socket_path,
        "connectors.getAuthUrl",
        serde_json::json!({ "id": id }),
        std::time::Duration::from_secs(5),
    )
        .await
        .map_err(|e| e.to_string())
}

/// Inspect the encrypted op-log and return a recovery plan listing every
/// source ever ingested (minus those forgotten), annotated with whether
/// it's recoverable (file still on disk), already-present, file-missing,
/// or otherwise unrecoverable. Read-only: no side effects on the cortex.
#[tauri::command]
async fn recovery_plan(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
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
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
        }
    };
    let params = serde_json::json!({ "sourceIds": source_ids });
    // recovery.apply is now ASYNC on the sidecar side: it returns
    // `{ accepted, jobId }` immediately, then pushes progress + final
    // report via the events socket. A short timeout is fine — we're
    // only waiting for the job to be accepted, not for it to finish.
    // Re-ingesting a 4233-page PDF can take 60-90 minutes; the UI
    // shouldn't be blocked, and Rust definitely shouldn't time out.
    ipc_client::request_with_timeout(
        &socket_path,
        "recovery.apply",
        params,
        std::time::Duration::from_secs(15),
    )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn reveal_file_in_finder(path: String) -> Result<(), String> {
    // `open -R <path>` selects the file inside Finder (reveals it in its
    // containing folder).  Works for any absolute path; falls back to just
    // opening the parent directory when the file has been moved.
    std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn open_cortex_in_finder(state: State<'_, AppState>) -> Result<(), String> {
    let path = {
        let inner = state.inner.lock().await;
        inner.cortex_dir.clone()
    };
    let path = path.ok_or_else(|| "cortex is locked".to_string())?;
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

/// Open an external URL in the user's default browser.
///
/// Used by the About window's link list (Website / Source / Docs / Privacy).
/// Webview anchors with `href="https://…"` are blocked by Tauri's top-level
/// navigation guard, so the page invokes this command instead of relying
/// on plain HTML navigation. Delegates to the `tauri-plugin-opener` plugin
/// which handles per-OS quirks (macOS `open`, Windows `start`, Linux
/// `xdg-open`) without us reimplementing that logic.
#[tauri::command]
async fn open_external_url(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|e| format!("could not open url: {e}"))
}

/// Show a native Save dialog, then write `content` to the chosen path.
/// Returns `Ok(true)` if the file was saved, `Ok(false)` if the user cancelled.
#[tauri::command]
async fn save_json_file(
    app: AppHandle,
    default_name: String,
    content: String,
) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    use std::fs;

    let path = app
        .dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter("JSON", &["json"])
        .blocking_save_file();

    match path {
        Some(p) => {
            let dest = p.as_path()
                .ok_or_else(|| "invalid path".to_string())?;
            fs::write(dest, content.as_bytes())
                .map_err(|e| format!("could not write file: {e}"))?;
            Ok(true)
        }
        None => Ok(false), // user cancelled
    }
}

/// Install the macOS application menu with "Graphnosis" as the app name.
///
/// Without this, the first menu item reads "graphnosis-app" (the Rust
/// binary name) in dev mode. In a bundled .app it would read the
/// CFBundleName from Info.plist, but Tauri's default menu builder
/// always uses the binary name regardless of bundle metadata. Setting
/// the menu explicitly fixes the title in both modes.
///
/// The About item is wired to our `open_about_window` command so the
/// rich HTML About panel takes over from the macOS native dialog.
#[cfg(target_os = "macos")]
fn install_app_menu(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{
        AboutMetadataBuilder, CheckMenuItem, MenuBuilder, MenuItemBuilder,
        PredefinedMenuItem, SubmenuBuilder,
    };
    use tauri_plugin_autostart::ManagerExt;

    let about_item = MenuItemBuilder::with_id("graphnosis-about", "About Graphnosis")
        .build(app)?;

    let launch_at_login_checked = app.autolaunch().is_enabled().unwrap_or(false);
    let launch_at_login_item = CheckMenuItem::with_id(
        app,
        "graphnosis-launch-at-login",
        "Launch at Login",
        true,
        launch_at_login_checked,
        None::<&str>,
    )?;

    let app_submenu = SubmenuBuilder::new(app, "Graphnosis")
        .item(&about_item)
        .separator()
        .item(&launch_at_login_item)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    // Standard Edit menu — gives ⌘Z / ⌘X / ⌘C / ⌘V / ⌘A their native
    // bindings in the webview. Without it, common shortcuts feel broken
    // (esp. in text inputs).
    let edit_submenu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    // Window menu — Minimize / Zoom / Close. Native Mac users expect it.
    let window_submenu = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .item(&PredefinedMenuItem::close_window(app, None)?)
        .build()?;

    let menu = MenuBuilder::new(app)
        .item(&app_submenu)
        .item(&edit_submenu)
        .item(&window_submenu)
        .build()?;

    app.set_menu(menu)?;

    // Route custom app-menu clicks.
    let app_for_handler = app.clone();
    app.on_menu_event(move |_app, event| {
        match event.id().as_ref() {
            "graphnosis-about" => {
                let app_inner = app_for_handler.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = open_about_window(app_inner).await;
                });
            }
            "graphnosis-launch-at-login" => {
                use tauri_plugin_autostart::ManagerExt;
                let autolaunch = app_for_handler.autolaunch();
                let currently = autolaunch.is_enabled().unwrap_or(false);
                if currently { let _ = autolaunch.disable(); } else { let _ = autolaunch.enable(); }
                // Sync the tray checkmark to match.
                let new_state = autolaunch.is_enabled().unwrap_or(!currently);
                let app_inner = app_for_handler.clone();
                tauri::async_runtime::spawn(async move {
                    let state = app_inner.state::<AppState>();
                    let snapshot = {
                        let inner = state.inner.lock().await;
                        StatusSnapshot {
                            unlocked: inner.sidecar.is_some(),
                            cortex_dir: inner.cortex_dir.as_ref().map(|p| p.to_string_lossy().into_owned()),
                            sidecar_running: inner.sidecar.is_some(),
                        }
                    };
                    tray::refresh_status_with_autostart(&app_inner, &snapshot, new_state);
                });
            }
            _ => {}
        }
    });

    // Suppress the unused-variable lint on AboutMetadataBuilder — it's
    // available for callers who want to revert to the native panel.
    let _ = AboutMetadataBuilder::new();

    Ok(())
}

/// Open a custom HTML About window.
///
/// The native macOS About panel (Application menu → About Graphnosis) is
/// minimal — name, icon, version, copyright. This command spawns a small
/// dedicated Tauri window backed by `about.html` so we can render a richer
/// view: tagline, links to the website + repo + privacy policy, build
/// metadata, attributions, and a "what's new" link to the changelog.
///
/// If the window is already open, focus it instead of spawning a duplicate.
/// Sized small (480×360) and non-resizable so it reads like a panel, not
/// a second main window.
#[tauri::command]
async fn open_about_window(app: AppHandle) -> Result<(), String> {
    const LABEL: &str = "about";
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    // about.html is bundled alongside index.html via the frontendDist
    // pipeline. The Tauri webview uses tauri:// URLs in production and
    // localhost:5173 in dev — `WebviewUrl::App("about.html".into())`
    // resolves correctly for both.
    tauri::WebviewWindowBuilder::new(
        &app,
        LABEL,
        tauri::WebviewUrl::App("about.html".into()),
    )
        .title("About Graphnosis")
        .inner_size(480.0, 500.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .visible(true)
        .build()
        .map_err(|e| format!("could not open About window: {e}"))?;
    Ok(())
}

#[tauri::command]
async fn set_graph_archived(
    state: State<'_, AppState>,
    graph_id: String,
    archived: bool,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
        }
    };
    let params = serde_json::json!({ "graphId": graph_id, "archived": archived });
    ipc_client::request(&socket_path, "graphs.setArchived", params)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn rename_graph(
    state: State<'_, AppState>,
    graph_id: String,
    display_name: String,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
        }
    };
    let params = serde_json::json!({ "graphId": graph_id, "displayName": display_name });
    ipc_client::request(&socket_path, "graphs.rename", params)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_graph_tier(
    state: State<'_, AppState>,
    graph_id: String,
    tier: String,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
        }
    };
    let params = serde_json::json!({ "graphId": graph_id, "tier": tier });
    ipc_client::request(&socket_path, "graphs.setTier", params)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_consent_phrase(
    state: State<'_, AppState>,
    tier: String,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
        }
    };
    let params = serde_json::json!({ "tier": tier });
    ipc_client::request(&socket_path, "ai.getConsentPhrase", params)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn revoke_ai_consents(
    state: State<'_, AppState>,
    client_name: Option<String>,
    tier: Option<String>,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
        }
    };
    let mut params = serde_json::Map::new();
    if let Some(cn) = client_name {
        params.insert("clientName".to_string(), serde_json::json!(cn));
    }
    if let Some(t) = tier {
        params.insert("tier".to_string(), serde_json::json!(t));
    }
    ipc_client::request(&socket_path, "ai.revokeConsents", serde_json::Value::Object(params))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn engram_set_config(
    state: State<'_, AppState>,
    engram_id: String,
    tier: Option<String>,
    consent_interval_ms: Option<i64>,
    clear_consent_interval: Option<bool>,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
        }
    };
    let mut params = serde_json::json!({ "engramId": engram_id });
    if let Some(t) = tier {
        params["tier"] = serde_json::json!(t);
    }
    if let Some(ms) = consent_interval_ms {
        params["consentIntervalMs"] = serde_json::json!(ms);
    }
    if let Some(true) = clear_consent_interval {
        params["clearConsentInterval"] = serde_json::json!(true);
    }
    ipc_client::request(&socket_path, "engram.setConfig", params)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn move_source(
    state: State<'_, AppState>,
    from_graph_id: String,
    source_id: String,
    to_graph_id: String,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
        }
    };
    let params = serde_json::json!({
        "fromGraphId": from_graph_id,
        "sourceId": source_id,
        "toGraphId": to_graph_id,
    });
    // Moving a source involves forgetSource (soft-delete + disk write) then
    // re-ingest into the destination engram — can take well over 5s for
    // large sources, so use a generous budget instead of the default 5s.
    ipc_client::request_with_timeout(
        &socket_path,
        "sources.move",
        params,
        std::time::Duration::from_secs(60),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_graph(
    state: State<'_, AppState>,
    graph_id: String,
) -> Result<serde_json::Value, String> {
    let socket_path = {
        let inner = state.inner.lock().await;
        match inner.sidecar.as_ref() {
            Some(h) => h.socket_path.clone(),
            None => return Err("cortex is locked".to_string()),
        }
    };
    let params = serde_json::json!({ "graphId": graph_id });
    // Deletion flushes settings.json + unlinks up to 6 files — 30s is plenty.
    ipc_client::request_with_timeout(
        &socket_path,
        "graphs.delete",
        params,
        std::time::Duration::from_secs(30),
    )
        .await
        .map_err(|e| e.to_string())
}

/// Trigger a manual update check from the frontend (Settings, About, etc.).
/// Returns the new version string if an update is available, or None.
/// Downloads and installs the pending update, then restarts the app.
/// Called from the in-app update modal when the user clicks "Install & Restart".
/// Re-checks the endpoint so we always install from a fresh manifest.
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await.map_err(|e| e.to_string())? {
        Some(update) => update
            .download_and_install(|_, _| {}, || {})
            .await
            .map_err(|e| e.to_string()),
        None => Err("No update available".to_string()),
    }
}

/// Also stores the result in UpdateState and refreshes the tray.
#[tauri::command]
async fn check_for_updates(app: AppHandle) -> Result<Option<String>, String> {
    match run_update_check(app).await {
        Ok(v) => Ok(v),
        Err(e) => {
            eprintln!("[updater] check failed: {}", e);
            Err(e.to_string())
        }
    }
}

/// Core update check logic — shared by the startup background check and the
/// `check_for_updates` Tauri command. Fetches `latest.json`, compares it to
/// the running version, and if a newer build is available:
///   1. Stores the version in UpdateState so the tray can reflect it.
///   2. Refreshes the tray menu to show "Update Available".
///   3. Posts a macOS notification so the user notices even with the window hidden.
///
/// Returns `Some(version)` if an update was found, `None` otherwise.
async fn run_update_check(app: AppHandle) -> anyhow::Result<Option<String>> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app.updater()?.check().await?;
    let Some(update) = update else { return Ok(None) };

    let version = update.version.clone();

    // Persist so the tray and install flow can reference it without re-checking.
    if let Some(s) = app.try_state::<UpdateState>() {
        if let Ok(mut v) = s.available_version.lock() {
            *v = Some(version.clone());
        }
    }

    // Refresh tray: read current app status then rebuild the menu.
    {
        let state = app.state::<AppState>();
        let snapshot = current_status(&state).await;
        tray::refresh_status(&app, &snapshot);
    }

    // Notify the user even when the window is hidden.
    // On macOS: use mac-notification-sys directly with wait_for_click so
    // clicking the banner re-opens the panel to show the in-app update modal.
    #[cfg(target_os = "macos")]
    {
        let app_clone = app.clone();
        let version_str = version.clone();
        std::thread::spawn(move || {
            let result = mac_notification_sys::Notification::new()
                .title("Graphnosis Update Available")
                .message(&format!(
                    "Version {} is ready. Click to install.",
                    version_str
                ))
                .wait_for_click(true)
                .send();
            if let Ok(mac_notification_sys::NotificationResponse::Click) = result {
                if let Some(win) = app_clone.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = app
            .notification()
            .builder()
            .title("Graphnosis Update Available")
            .body(&format!(
                "Version {} is ready. Open the menu-bar icon to install.",
                version
            ))
            .show();
    }

    // Emit to the frontend so the in-app update modal can appear.
    let _ = app.emit("graphnosis://update-available", version.clone());

    Ok(Some(version))
}

async fn current_status(state: &State<'_, AppState>) -> StatusSnapshot {
    let inner = state.inner.lock().await;
    StatusSnapshot {
        unlocked: inner.cortex_dir.is_some() && inner.sidecar.is_some(),
        cortex_dir: inner
            .cortex_dir
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
        .manage(UpdateState { available_version: std::sync::Mutex::new(None) })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            pick_cortex_folder,
            check_path_exists,
            suggest_cortex_path,
            create_cortex_dir,
            unlock_cortex,
            unlock_cortex_with_recovery,
            biometric_available,
            biometric_unlock,
            change_passphrase,
            regenerate_recovery_phrase,
            list_quarantine,
            delete_quarantine,
            restore_quarantine,
            lock_cortex,
            status,
            inspector_stats,
            node_cursor,
            ingest_file,
            pick_and_ingest_file,
            pick_files,
            pick_folders,
            forget_source,
            reingest_source,
            purge_forgotten,
            mcp_status,
            mcp_restart_listener,
            list_pending_corrections,
            apply_correction,
            reject_correction,
            list_graphs_with_metadata,
            create_graph_with_template,
            accept_engram_suggestion,
            show_engram_action_notification,
            search_nodes,
            list_nodes,
            list_edges,
            node_direct_edit,
            node_soft_delete,
            node_link,
            node_link_directed,
            node_unlink,
            list_activity,
            list_snapshots,
            create_snapshot,
            recovery_plan,
            recovery_apply,
            get_settings,
            update_settings,
            get_mobile_connection_info,
            list_connectors,
            install_connector,
            remove_connector,
            trigger_connector_pull,
            get_connector_auth_url,
            configure_mcp_client,
            open_cortex_in_finder,
            reveal_file_in_finder,
            show_window,
            open_about_window,
            open_external_url,
            save_json_file,
            set_graph_archived,
            set_graph_tier,
            get_consent_phrase,
            revoke_ai_consents,
            engram_set_config,
            rename_graph,
            move_source,
            delete_graph,
            sidecar_ipc_call,
            check_for_updates,
            install_update,
        ])
        .setup(|app| {
            // Full-blown Mac app: regular activation so we get a Dock icon,
            // ⌘Tab participation, and the standard window-first experience.
            // Tray icon stays as an ambient status indicator and quick-action
            // surface — but the App's home is now the main window.
            #[cfg(target_os = "macos")]
            {
                let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
                // Override the application menu so the first item reads
                // "Graphnosis" instead of the Rust binary name
                // (`graphnosis-app`). macOS auto-names the app menu from
                // the binary in dev, and from CFBundleName in a bundled
                // .app — but Tauri's default menu builder always uses the
                // binary name. Setting the title explicitly here fixes
                // it in both modes. About item is wired to our custom
                // open_about_window command so the rich HTML About panel
                // replaces macOS's default name-icon-version dialog.
                if let Err(e) = install_app_menu(app.handle()) {
                    eprintln!("[graphnosis-app] failed to install app menu: {e}");
                }
            }
            // Show the main window on startup. The user sees the unlock view
            // immediately; tray "Show" still works for re-showing after ⌘W.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
            // Tray icon + menu.
            tray::create(app.handle())?;
            // Silent background update check — delayed so it doesn't race
            // startup I/O. Fires 15 s after the app is ready.
            // Skipped in debug builds: no `latest.json` exists until a release is published.
            #[cfg(not(debug_assertions))]
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(15)).await;
                    if let Err(e) = run_update_check(handle).await {
                        eprintln!("[updater] background check failed: {}", e);
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Close button hides the MAIN window rather than quitting the app —
            // we're a menu-bar resident; quit is via the tray "Quit" item.
            // Secondary windows (About, etc.) are allowed to close normally —
            // intercepting their CloseRequested fires the "Synapse is running"
            // notification spuriously and produces a macOS "Choose Application"
            // dialog from mac_notification_sys's use_default URL handler.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    // Let the window close and destroy itself naturally.
                    return;
                }
                let _ = window.hide();
                api.prevent_close();
                // Let the user know the app is still alive so AI clients,
                // agents, and connectors keep working without the window open.
                // On macOS: send via mac-notification-sys with wait_for_click so
                // clicking the notification banner re-opens the panel immediately.
                #[cfg(target_os = "macos")]
                {
                    let app_clone = window.app_handle().clone();
                    std::thread::spawn(move || {
                        let result = mac_notification_sys::Notification::new()
                            .title("Graphnosis Synapse is running")
                            .message("Your AI clients, agents, and connectors stay active. Click to reopen.")
                            .wait_for_click(true)
                            .send();
                        if let Ok(mac_notification_sys::NotificationResponse::Click) = result {
                            if let Some(win) = app_clone.get_webview_window("main") {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    });
                }
                #[cfg(not(target_os = "macos"))]
                {
                    use tauri_plugin_notification::NotificationExt;
                    let _ = window
                        .app_handle()
                        .notification()
                        .builder()
                        .title("Graphnosis Synapse is running")
                        .body("Your AI clients, agents, and connectors stay active. Reopen anytime from the menu bar icon.")
                        .show();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running Graphnosis")
        .run(|app_handle, event| {
            // Dock-icon click (or Cmd+Tab → click) after the window has been
            // hidden: bring the main window back to the front. macOS fires
            // `Reopen` when the app is already running and the user activates
            // it via the Dock or the application switcher.
            if let tauri::RunEvent::Reopen { has_visible_windows, .. } = &event {
                if !has_visible_windows {
                    if let Some(win) = app_handle.get_webview_window("main") {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
            }

            // Intercept every exit path (tray Quit, Cmd+Q, macOS App > Quit,
            // app.exit() from a command, etc.) and synchronously shut down
            // the sidecar. The tray Quit handler does this too, but Cmd+Q
            // bypasses it — without this hook the sidecar gets reparented
            // to launchd and lives on as an orphan.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let state = app_handle.state::<AppState>();
                tauri::async_runtime::block_on(async {
                    let (handle, stream) = {
                        let mut inner = state.inner.lock().await;
                        (inner.sidecar.take(), inner.event_stream.take())
                    };
                    if let Some(s) = stream {
                        s.shutdown().await;
                    }
                    if let Some(h) = handle {
                        let _ = h.shutdown().await;
                    }
                });
            }
        });
}

