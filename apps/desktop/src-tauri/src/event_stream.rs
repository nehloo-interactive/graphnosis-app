//! Long-lived push-event channel from the sidecar.
//!
//! Connects to `<vault>/events.sock` and reads newline-delimited JSON frames.
//! Each frame is forwarded to the frontend via Tauri's event system as
//! `graph-mutation`. The frontend listens once at startup and refreshes
//! whichever panes care about the affected graph.
//!
//! Failure handling: if the connection drops (sidecar restart, socket churn
//! from a vault relock), we wait for the socket file to reappear and try
//! again with bounded exponential backoff. A cancellation token lets the
//! Tauri layer kill the loop on vault lock.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tokio::time::timeout;

/// Frame discriminator. The sidecar sends either a `hello` (one per
/// connect, with a cursor snapshot) or `event` frames (one per graph
/// mutation, throttled server-side). Unknown frame kinds are logged
/// and skipped so we can add new frame types later without breaking
/// old clients.
#[derive(Deserialize)]
struct Frame {
    kind: String,
    #[allow(dead_code)]
    name: Option<String>,
    payload: Value,
}

#[derive(Serialize, Clone)]
struct GraphMutationPayload {
    #[serde(rename = "graphId")]
    graph_id: String,
    ts: i64,
}

#[derive(Serialize, Clone)]
struct GraphHelloPayload {
    ts: i64,
    /// Snapshot of `{graphId: lastMutationTs}` at connection time.
    /// Lets the frontend reconcile against its locally-cached cursor.
    cursor: Value,
}

/// Handle returned by [`spawn`]. Drop it (or call `shutdown`) to terminate
/// the background read loop. We deliberately don't try to abort the task
/// from outside — the loop polls a cancellation Notify on every iteration
/// so it shuts down cleanly between reads.
pub struct EventStreamHandle {
    cancel: Arc<Notify>,
    join: JoinHandle<()>,
}

impl EventStreamHandle {
    pub async fn shutdown(self) {
        self.cancel.notify_waiters();
        // Best-effort: give the loop a moment to exit on its own;
        // if it doesn't (e.g., stuck in a blocking read), the task
        // drop will abort it.
        let _ = timeout(Duration::from_millis(500), self.join).await;
    }
}

/// Spawn the event-stream reader for a given vault. Returns a handle the
/// caller holds until vault lock / app shutdown.
///
/// The reader keeps trying to connect — if the sidecar isn't up yet at the
/// time of unlock (race), the first connect will fail and we retry. Bounded
/// backoff caps at 5s between attempts.
pub fn spawn(app: AppHandle, vault_dir: PathBuf) -> EventStreamHandle {
    let cancel = Arc::new(Notify::new());
    let cancel_inner = cancel.clone();
    let socket_path = vault_dir.join("events.sock");

    let join = tokio::spawn(async move {
        let mut backoff_ms: u64 = 100;
        loop {
            // Cancellation check: race the connect against the cancel notify.
            let connect_or_cancel = tokio::select! {
                biased;
                _ = cancel_inner.notified() => None,
                result = open_and_read(&app, &socket_path) => Some(result),
            };
            match connect_or_cancel {
                None => return, // cancelled
                Some(Ok(())) => {
                    // Connection ended cleanly (sidecar closed the socket).
                    // Reset backoff and try to reconnect — vault is still
                    // unlocked or we'd have been cancelled.
                    backoff_ms = 100;
                }
                Some(Err(e)) => {
                    eprintln!("[event_stream] connection lost: {} (retry in {}ms)", e, backoff_ms);
                }
            }
            // Sleep with cancellation. If cancelled mid-sleep, exit promptly.
            tokio::select! {
                biased;
                _ = cancel_inner.notified() => return,
                _ = tokio::time::sleep(Duration::from_millis(backoff_ms)) => {}
            }
            backoff_ms = (backoff_ms * 2).min(5_000);
        }
    });

    EventStreamHandle { cancel, join }
}

async fn open_and_read(app: &AppHandle, socket_path: &Path) -> Result<()> {
    let stream = UnixStream::connect(socket_path)
        .await
        .with_context(|| format!("connect to events socket at {}", socket_path.display()))?;
    let reader = BufReader::new(stream);
    let mut lines = reader.lines();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let frame: Frame = match serde_json::from_str(&line) {
            Ok(f) => f,
            Err(e) => {
                eprintln!("[event_stream] bad frame from sidecar (ignored): {} (raw: {})", e, line);
                continue;
            }
        };
        match frame.kind.as_str() {
            "event" => {
                // payload shape: { graphId: string, ts: number }
                if let (Some(graph_id), Some(ts)) = (
                    frame.payload.get("graphId").and_then(|v| v.as_str()).map(String::from),
                    frame.payload.get("ts").and_then(|v| v.as_i64()),
                ) {
                    let payload = GraphMutationPayload { graph_id, ts };
                    let _ = app.emit("graphnosis://graph-mutation", &payload);
                } else {
                    eprintln!("[event_stream] event frame missing graphId/ts: {}", line);
                }
            }
            "hello" => {
                // Forward to the frontend so it can reconcile cursor on
                // (re)connect — handy after a sidecar restart, where
                // events emitted during the gap are missed.
                if let Some(ts) = frame.payload.get("ts").and_then(|v| v.as_i64()) {
                    let cursor = frame
                        .payload
                        .get("cursor")
                        .cloned()
                        .unwrap_or(Value::Object(Default::default()));
                    let payload = GraphHelloPayload { ts, cursor };
                    let _ = app.emit("graphnosis://event-stream-connected", &payload);
                }
            }
            other => {
                eprintln!("[event_stream] unknown frame kind '{}' (ignored)", other);
            }
        }
    }
    // EOF on the socket — sidecar closed its side. The outer loop will
    // wait briefly and try to reconnect.
    Ok(())
}
