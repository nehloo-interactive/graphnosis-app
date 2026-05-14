//! Newline-delimited JSON-RPC client over a Unix domain socket.
//!
//! Matches the protocol the sidecar speaks on `<vault>/sidecar.sock`:
//!   request:  {"id": <number|string>, "method": <string>, "params": <any>}\n
//!   response: {"id": <same>, "result": <any>} \n
//!             OR
//!             {"id": <same>, "error": <string>}\n

use std::path::Path;

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
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
    let stream = UnixStream::connect(socket_path)
        .await
        .with_context(|| format!("connect to sidecar at {}", socket_path.display()))?;

    let (read_half, mut write_half) = stream.into_split();

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

    let response: Response = serde_json::from_str(&line)
        .with_context(|| format!("parse sidecar response: {}", line.trim()))?;

    if let Some(err) = response.error {
        return Err(anyhow!("sidecar error: {}", err));
    }
    response.result.ok_or_else(|| anyhow!("sidecar response missing both result and error"))
}
