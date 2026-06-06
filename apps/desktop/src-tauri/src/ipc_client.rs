//! Newline-delimited JSON-RPC client over a Unix domain socket.
//!
//! Matches the protocol the sidecar speaks on `<cortex>/sidecar.sock`:
//!   request:  {"id": <number|string>, "method": <string>, "params": <any>}\n
//!   response: {"id": <same>, "result": <any>} \n
//!             OR
//!             {"id": <same>, "error": <string>}\n

use std::path::Path;

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::time::{timeout, Duration};

#[derive(Serialize)]
struct Request<'a> {
    id: u64,
    method: &'a str,
    params: &'a Value,
}

#[derive(Deserialize)]
struct Response {
    #[allow(dead_code)]
    id: Option<Value>,
    result: Option<Value>,
    error: Option<Value>,
}

/// Default IPC timeout. Tight enough to catch a hung sidecar on fast
/// metadata calls; callers that know they're slow (ingest, recall, recovery)
/// should use [`request_with_timeout`] with a generous budget.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(5);

/// Send one request and wait for its response. The sidecar serves one request
/// per line; we open a fresh connection per call rather than multiplexing —
/// stateless and easier to reason about.
pub async fn request(socket_path: &Path, method: &str, params: Value) -> Result<Value> {
    request_with_timeout(socket_path, method, params, DEFAULT_TIMEOUT).await
}

/// Same as [`request`] but with an explicit timeout. Use when the operation
/// is known to be slow (PDF ingest, embedding rebuild, op-log replay) — the
/// default 5s budget will reliably trip on these and leave the user staring
/// at a misleading "sidecar didn't respond" error.
pub async fn request_with_timeout(
    socket_path: &Path,
    method: &str,
    params: Value,
    timeout_dur: Duration,
) -> Result<Value> {
    #[cfg(unix)]
    // NB: do NOT embed the socket path in this error — it propagates to the UI
    // and would leak the full cortex path on screen (bad in demos/recordings).
    // The path is constant (<cortex>/sidecar.sock); the message stays path-free.
    let stream = tokio::net::UnixStream::connect(socket_path)
        .await
        .context("connect to sidecar (memory engine not reachable)")?;
    #[cfg(windows)]
    let stream = {
        let addr = socket_path.to_str()
            .ok_or_else(|| anyhow!("socket address is not valid UTF-8"))?;
        tokio::net::TcpStream::connect(addr)
            .await
            .context("connect to sidecar (memory engine not reachable)")?
    };

    let (read_half, mut write_half) = tokio::io::split(stream);

    let payload = serde_json::to_vec(&Request {
        id: 1,
        method,
        params: &params,
    })?;

    write_half.write_all(&payload).await?;
    write_half.write_all(b"\n").await?;
    write_half.flush().await?;

    let mut reader = BufReader::new(read_half);
    let mut line = String::new();

    timeout(timeout_dur, reader.read_line(&mut line))
        .await
        .map_err(|_| anyhow!(
            "sidecar did not respond within {}s for method `{}`",
            timeout_dur.as_secs(),
            method,
        ))??;

    if line.trim().is_empty() {
        return Err(anyhow!("sidecar returned empty response"));
    }

    // On parse failure, surface the exact serde location (line + column +
    // reason) AND the size of the buffer we tried to parse. Previously the
    // context-only message swallowed serde's "EOF while parsing value at line
    // 1 column N" detail, which made multi-MB responses (e.g. nodes.list on
    // a 3.7k-node engram) look mysteriously broken when the real cause was
    // a truncated read or oversized payload. Bytes-read tells us instantly
    // whether the line is truncated vs. invalid JSON of full size.
    let response: Response = match serde_json::from_str::<Response>(&line) {
        Ok(r) => r,
        Err(serde_err) => {
            let trimmed = line.trim();
            // Show a window around the byte offset serde reports — that's
            // the only way to find which node's content has the bad escape
            // when the response is multi-MB. Char-boundary-safe slicing so
            // we don't panic on multi-byte UTF-8 inside the window.
            let col = serde_err.column();
            let window_start = col.saturating_sub(150);
            let window_end = (col + 150).min(trimmed.len());
            // Walk forward / backward to char boundaries — slicing in the
            // middle of a UTF-8 sequence would panic.
            let safe_start = (window_start..=window_end)
                .find(|&i| trimmed.is_char_boundary(i))
                .unwrap_or(window_start);
            let safe_end = (safe_start..=window_end)
                .rev()
                .find(|&i| trimmed.is_char_boundary(i))
                .unwrap_or(window_end);
            let window = &trimmed[safe_start..safe_end];
            return Err(anyhow!(
                "parse sidecar response failed: {serde_err} (bytes read: {len}, window around col {col}: {window:?})",
                len = trimmed.len(),
            ));
        }
    };

    if let Some(err) = response.error {
        return Err(anyhow!("sidecar error: {}", err));
    }
    response.result.ok_or_else(|| anyhow!("sidecar response missing both result and error"))
}
