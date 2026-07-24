//! Remote-cortex ("thin-client") transport.
//!
//! In remote mode the desktop shell does NOT spawn a local Node sidecar.
//! Instead it drives a *remote* sidecar's browser-services HTTP bridge — the
//! same `httpUi` server a browser web-app client uses — over Tailscale (or any
//! authenticated network path). This module is the Rust equivalent of the
//! frontend's `browserRpc`/SSE client in `platform.ts`:
//!
//!   POST {base}/api/unlock  { token }            -> { token: <session> }
//!   POST {base}/api/rpc     { method, params }   -> { result | error }   (Bearer session)
//!   GET  {base}/api/events                        -> text/event-stream    (Bearer session)
//!
//! The `/api/rpc` endpoint dispatches through the SAME `dispatch()` the local
//! Unix-socket IPC server uses, so the method/params/result contract is
//! byte-identical to local mode — only the transport differs. That is what
//! lets a single shell binary act as either a standalone app (local sidecar)
//! or a thin client (remote sidecar) with no divergence above this layer.

use std::sync::RwLock;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde_json::Value;
use tokio::sync::OnceCell;

// ── Live remote session (process-global) ─────────────────────────────────────
//
// Remote mode is process-wide and decided at startup by `configured_base()`;
// the session bearer is minted at unlock. `ipc_client` reads this on every
// request and, when present, routes to the remote HTTP bridge instead of the
// local Unix socket — which is what lets all ~54 existing IPC call sites stay
// untouched. Reads are brief clones with no `.await` held across the lock.
static SESSION: RwLock<Option<(String, String)>> = RwLock::new(None);

/// Record the active remote session `(base, session_bearer)` after a
/// successful `/api/unlock`. Subsequent IPC routes to `base` with this bearer.
pub fn set_session(base: String, session: String) {
    *SESSION.write().expect("remote session lock poisoned") =
        Some((base.trim_end_matches('/').to_string(), session));
}

/// Clear the active remote session (cortex lock / re-unlock). After this,
/// `current()` is `None` and IPC would report "cortex is locked" upstream.
pub fn clear_session() {
    *SESSION.write().expect("remote session lock poisoned") = None;
}

/// The active remote session `(base, session_bearer)`, if unlocked remotely.
/// `None` in local-sidecar mode or before a remote unlock.
pub fn current() -> Option<(String, String)> {
    SESSION.read().expect("remote session lock poisoned").clone()
}

/// Environment override that puts the shell into remote mode. When set, the
/// shell skips spawning a local sidecar and routes all IPC to this base URL.
/// The value is the bridge ORIGIN with no trailing slash or path, e.g.
/// `https://lahzr-ai-1.tail766d3d.ts.net:8443`. Settings-driven configuration
/// (a "Connect to remote cortex" picker) can supply the same value later.
pub const REMOTE_URL_ENV: &str = "GRAPHNOSIS_REMOTE_URL";
/// Optional: pre-supply the access token so a dev thin-client can unlock
/// without typing it on the lock screen. Normally the user enters it.
pub const REMOTE_TOKEN_ENV: &str = "GRAPHNOSIS_REMOTE_TOKEN";

/// Sentinel embedded in the error the event pump raises when the remote server
/// rejects the session (HTTP 401): the token was revoked, the 24h session
/// expired, or the server restarted with a fresh token. The pump matches on
/// this to drop the session and bounce the UI to the lock screen.
pub const SESSION_EXPIRED_MARKER: &str = "graphnosis-remote-session-expired";

/// A resolved remote connection: the bridge origin plus the current session
/// bearer (minted by `/api/unlock`). Cloned into each `IpcTarget::Remote` so
/// the IPC client stays stateless. `session` is `None` until unlock succeeds.
#[derive(Clone, Debug)]
pub struct RemoteConn {
    pub base: String,
    pub session: Option<String>,
}

impl RemoteConn {
    pub fn new(base: String) -> Self {
        // Normalise: strip a trailing slash so `{base}/api/...` never doubles.
        let base = base.trim_end_matches('/').to_string();
        Self { base, session: None }
    }
}

/// Read the configured remote base URL from the environment, if any. Returns
/// `None` for a normal (local-sidecar) launch. Blank/whitespace is treated as
/// unset so an empty env var doesn't force a broken remote mode.
pub fn configured_base() -> Option<String> {
    match std::env::var(REMOTE_URL_ENV) {
        Ok(v) if !v.trim().is_empty() => Some(v.trim().trim_end_matches('/').to_string()),
        _ => None,
    }
}

/// Pre-supplied access token for headless/dev unlock, if any.
pub fn configured_token() -> Option<String> {
    match std::env::var(REMOTE_TOKEN_ENV) {
        Ok(v) if !v.trim().is_empty() => Some(v.trim().to_string()),
        _ => None,
    }
}

/// Human-readable label for the remote server, used as the cortex name in the
/// header/tray in place of a local folder path. Strips the URL scheme and any
/// trailing slash, leaving `host[:port]` (e.g. `lahzr-ai-1.tail766d3d.ts.net`).
pub fn display_label(base: &str) -> String {
    let s = base.trim();
    let s = s
        .strip_prefix("https://")
        .or_else(|| s.strip_prefix("http://"))
        .unwrap_or(s);
    s.trim_end_matches('/').to_string()
}

/// Shared HTTP client. Built once; reqwest pools connections internally so a
/// single client is correct (and cheaper) across every RPC + the SSE stream.
/// rustls validates the real `*.ts.net` / Let's Encrypt certs `tailscale
/// serve` terminates — no custom trust roots needed.
static CLIENT: OnceCell<reqwest::Client> = OnceCell::const_new();

async fn client() -> Result<&'static reqwest::Client> {
    CLIENT
        .get_or_try_init(|| async {
            reqwest::Client::builder()
                // Per-request timeouts are applied at call sites; keep a
                // generous connect timeout so a sleeping tailnet peer waking
                // up doesn't instantly fail the first probe.
                .connect_timeout(Duration::from_secs(10))
                .user_agent(concat!("graphnosis-desktop/", env!("CARGO_PKG_VERSION")))
                .build()
                .context("build remote HTTP client")
        })
        .await
}

/// Exchange the access token for a session bearer. Mirrors `POST /api/unlock`.
/// The access token is the "Browser access" token from the remote app's
/// Mobile & Remote settings — NOT the MCP bridge bearer token.
pub async fn unlock(base: &str, access_token: &str) -> Result<String> {
    let url = format!("{}/api/unlock", base.trim_end_matches('/'));
    let res = client()
        .await?
        .post(&url)
        .json(&serde_json::json!({ "token": access_token }))
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .context("connect to remote cortex (is the server reachable and unlocked?)")?;
    let status = res.status();
    // Surface an auth rejection with a STABLE, specific phrase BEFORE parsing the
    // body — so a 401 with a non-JSON body (fronting proxy / auth gateway) is
    // still recognizable, and so token-based callers clear a revoked token only
    // on a genuine auth failure (never on a transient 5xx that happens to carry
    // a JSON error body). The generic branch below uses "failed", not "rejected".
    if status.as_u16() == 401 {
        return Err(anyhow!("Invalid or expired access token."));
    }
    let body: Value = res
        .json()
        .await
        .context("remote /api/unlock returned a non-JSON response (is this a Graphnosis bridge?)")?;
    if let Some(token) = body.get("token").and_then(|v| v.as_str()) {
        return Ok(token.to_string());
    }
    let err = body
        .get("error")
        .and_then(|v| v.as_str())
        .unwrap_or("unlock failed");
    Err(anyhow!("remote unlock failed ({}): {}", status, err))
}

/// One JSON-RPC call to the remote sidecar. Mirrors `browserRpc` in
/// `platform.ts`: `POST /api/rpc { method, params }` with the session bearer,
/// unwrapping `{ result | error }`. A 401 is surfaced distinctly so callers
/// can treat it as "session expired — re-unlock" rather than a generic error.
pub async fn rpc(
    base: &str,
    session: &str,
    method: &str,
    params: Value,
    timeout: Duration,
) -> Result<Value> {
    let url = format!("{}/api/rpc", base.trim_end_matches('/'));
    let res = client()
        .await?
        .post(&url)
        .bearer_auth(session)
        .json(&serde_json::json!({ "method": method, "params": params }))
        .timeout(timeout)
        .send()
        .await
        .with_context(|| format!("remote IPC `{}` — could not reach the server", method))?;

    if res.status().as_u16() == 401 {
        return Err(anyhow!(
            "Your remote session expired — reconnect from the lock screen."
        ));
    }
    if !res.status().is_success() {
        return Err(anyhow!(
            "remote IPC `{}` failed with HTTP {}",
            method,
            res.status()
        ));
    }
    let body: Value = res
        .json()
        .await
        .with_context(|| format!("parse remote response for `{}`", method))?;
    if let Some(err) = body.get("error") {
        // Match the local client's shape: sidecar-side errors become an Err.
        let msg = err.as_str().map(String::from).unwrap_or_else(|| err.to_string());
        return Err(anyhow!("sidecar error: {}", msg));
    }
    Ok(body.get("result").cloned().unwrap_or(Value::Null))
}

/// Open the remote event stream (`GET /api/events`, SSE). Returns the raw
/// streaming response; the caller reads `data:` frames and re-emits them as
/// Tauri events through the same mapping the local event reader uses. Kept
/// here so the reqwest/auth details live next to the other remote calls.
pub async fn open_events(base: &str, session: &str) -> Result<reqwest::Response> {
    let url = format!("{}/api/events", base.trim_end_matches('/'));
    let res = client()
        .await?
        .get(&url)
        .bearer_auth(session)
        .header("Accept", "text/event-stream")
        // No timeout: this is a long-lived stream.
        .send()
        .await
        .context("open remote event stream")?;
    if res.status().as_u16() == 401 {
        // Distinct signal so the pump can drop the session instead of quietly
        // retrying forever against a token the server will never accept again.
        return Err(anyhow!(SESSION_EXPIRED_MARKER));
    }
    if !res.status().is_success() {
        return Err(anyhow!("remote /api/events returned HTTP {}", res.status()));
    }
    Ok(res)
}
