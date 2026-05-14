//! Spawns and supervises the Node sidecar process.
//!
//! Resolution order for the sidecar binary:
//!   1. $GRAPHNOSIS_SIDECAR_BIN env var (full path to a Node script)
//!   2. workspace dev build: <repo>/apps/desktop-sidecar/dist/index.js
//!   3. fall back to `node` on PATH + workspace dev path
//!
//! After spawn, we wait up to 30s for the sidecar's Unix socket to appear,
//! which indicates IPC is up. If it doesn't appear, we report a clear error
//! so the unlock flow doesn't pretend everything's fine.

use std::collections::VecDeque;
use std::env;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::time::sleep;

/// How many of the sidecar's most-recent stderr lines we keep, so we can
/// classify startup failures by their actual log output. 200 is enough to
/// catch a full Node stack trace from the FATAL line through the exception.
const STDERR_BUFFER_LINES: usize = 200;

pub struct SidecarHandle {
    child: Child,
    pub socket_path: PathBuf,
    /// Ring buffer of the sidecar's most-recent stderr lines. Used for
    /// classifying startup failures into friendlier user-facing messages
    /// even when the process dies via signal (no clean exit code).
    _stderr_buffer: Arc<Mutex<VecDeque<String>>>,
}

impl SidecarHandle {
    pub async fn shutdown(mut self) -> Result<()> {
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
        // Sidecar releases its vault lock on SIGTERM; we also tidy the socket file.
        let _ = std::fs::remove_file(&self.socket_path);
        Ok(())
    }
}

pub async fn start(vault_dir: &Path, passphrase: &str) -> Result<SidecarHandle> {
    let socket_path = vault_dir.join("sidecar.sock");
    // Stale socket left by a previous orphan? Remove it; the sidecar would recreate
    // it cleanly, but having it pre-existing can mask the "is the new sidecar up?" check.
    let _ = std::fs::remove_file(&socket_path);

    let (program, args) = resolve_launch_command()?;

    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .env("GRAPHNOSIS_VAULT", vault_dir)
        .env("GRAPHNOSIS_PASSPHRASE", passphrase)
        .env("GRAPHNOSIS_IPC_SOCKET", &socket_path)
        // Default graph; the App could later make this user-configurable.
        .env("GRAPHNOSIS_DEFAULT_GRAPH", "personal")
        .stdin(Stdio::null())
        // Pipe stderr so we can: (a) mirror it to OUR stderr (dev terminal
        // still sees logs), and (b) keep a small ring buffer for classifying
        // startup failures. Inherit alone hid the lines from us, which made
        // "wrong passphrase" indistinguishable from "vault lock held" in the
        // UI when the sidecar died via signal.
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .with_context(|| format!("spawn sidecar ({} {})", program, args.join(" ")))?;

    // Drain stderr into a ring buffer while mirroring to our stderr. Detached
    // task — it lives until the pipe closes (child exit), at which point it
    // just returns.
    let stderr_buffer: Arc<Mutex<VecDeque<String>>> =
        Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_BUFFER_LINES)));
    if let Some(stderr) = child.stderr.take() {
        let buffer = stderr_buffer.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("{}", line);
                if let Ok(mut buf) = buffer.lock() {
                    if buf.len() >= STDERR_BUFFER_LINES {
                        buf.pop_front();
                    }
                    buf.push_back(line);
                }
            }
        });
    }

    // Wait for either the IPC socket to appear OR the child process to exit.
    // 30s is generous because the first launch may need to load the BGE
    // embeddings model. Exit-during-startup commonly means: wrong passphrase
    // (sidecar refused to overwrite an existing vault), missing env var, or
    // a fatal Node error. We surface that as a meaningful error instead of
    // making the user wait the full timeout for a soft failure.
    let start = std::time::Instant::now();
    let max = Duration::from_secs(30);
    loop {
        if socket_path.exists() {
            break;
        }
        if let Some(status) = child.try_wait().context("try_wait on sidecar")? {
            // Sidecar exited before the socket appeared. Give the stderr
            // reader task a brief moment to drain the last few lines from
            // the pipe — without this, we might check the ring buffer
            // before the FATAL line has been read into it.
            sleep(Duration::from_millis(200)).await;
            let tail = drain_stderr_tail(&stderr_buffer);
            return Err(anyhow!("{}", classify_startup_failure(&tail, status.code())));
        }
        if start.elapsed() >= max {
            // Process still alive but socket never appeared — slow boot or hang.
            let _ = child.kill().await;
            return Err(anyhow!(
                "sidecar did not start cleanly within 30s: socket {} did not appear. \
                 Check the dev terminal for stderr.",
                socket_path.display()
            ));
        }
        sleep(Duration::from_millis(150)).await;
    }

    Ok(SidecarHandle {
        child,
        socket_path,
        _stderr_buffer: stderr_buffer,
    })
}

/// Snapshot the ring buffer into a single joined string for pattern matching.
fn drain_stderr_tail(buffer: &Arc<Mutex<VecDeque<String>>>) -> String {
    match buffer.lock() {
        Ok(buf) => buf.iter().cloned().collect::<Vec<_>>().join("\n"),
        Err(_) => String::new(),
    }
}

/// Map sidecar stderr + exit code to a friendly user-facing message.
///
/// Stderr patterns are the source of truth: when native modules (fastembed,
/// libsodium) crash on teardown the process dies via signal and `exit_code`
/// is None, but the FATAL line was already logged. We prefer the log
/// classification and fall back to exit codes only when stderr is silent.
fn classify_startup_failure(stderr_tail: &str, exit_code: Option<i32>) -> String {
    // Wrong passphrase — sidecar's index.ts logs this exact prefix.
    if stderr_tail.contains("FATAL: failed to load existing graph: Decryption failed") {
        return "Wrong passphrase. Check that you typed it correctly and try again. \
                If you're certain the passphrase is right, the vault file may have been \
                corrupted — restore from a backup if you have one."
            .to_string();
    }
    // Vault lock held by a competing process.
    if stderr_tail.contains("FATAL: could not acquire vault lock")
        || stderr_tail.contains("another Graphnosis sidecar is already writing to this vault")
    {
        return "Another Graphnosis sidecar is already holding this vault's lock. \
                Quit any other Graphnosis instance (including Claude Desktop's MCP server \
                if it spawns its own sidecar), or run \
                `pkill -f apps/desktop-sidecar/dist/index.js` to clear orphans, then try again."
            .to_string();
    }
    // Missing env var, missing node binary, etc. — bubble up.
    if stderr_tail.contains("Missing env var") {
        return format!("Sidecar reported a missing configuration value. \
                        Check the terminal running `pnpm dev:desktop` for details. \
                        (sidecar exit code {})",
                       exit_code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".to_string()));
    }
    // Generic fallback — still informative, with the exit code if we have it.
    match exit_code {
        Some(2) => "Another Graphnosis sidecar is already holding this vault's lock. \
                    Quit it and try again."
            .to_string(),
        Some(1) => "Sidecar failed during startup. \
                    Most likely cause: wrong passphrase or a corrupted vault file. \
                    Check the terminal running `pnpm dev:desktop` for the sidecar's stderr."
            .to_string(),
        _ => format!("Sidecar exited unexpectedly during startup. \
                      Check the terminal running `pnpm dev:desktop` for the sidecar's stderr. \
                      (exit code {})",
                     exit_code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".to_string())),
    }
}

/// Public accessor for other modules that need the (node-binary, relay-script)
/// pair. Used by the "Configure Claude Desktop" flow to write a config that
/// matches whatever node + relay path this build of the App would invoke.
pub fn resolve_node_and_relay() -> Result<(PathBuf, PathBuf)> {
    let node = node_path()?;
    // Honor an explicit override for the relay too — symmetric with
    // GRAPHNOSIS_SIDECAR_BIN. A future packaged build will set this to the
    // bundled relay path.
    if let Ok(explicit) = env::var("GRAPHNOSIS_RELAY_BIN") {
        return Ok((node, PathBuf::from(explicit)));
    }
    if let Some(dist) = find_workspace_relay_dist() {
        return Ok((node, dist));
    }
    bail!(
        "Could not locate the Graphnosis MCP relay. \
         Run `pnpm -r build` in the workspace first, or set GRAPHNOSIS_RELAY_BIN."
    );
}

fn find_workspace_relay_dist() -> Option<PathBuf> {
    if let Ok(exe) = env::current_exe() {
        let mut cur = exe.parent()?.to_path_buf();
        for _ in 0..6 {
            let candidate = cur
                .join("apps")
                .join("desktop-sidecar")
                .join("dist")
                .join("mcp-relay.js");
            if candidate.exists() {
                return Some(candidate);
            }
            if let Some(p) = cur.parent() {
                cur = p.to_path_buf();
            } else {
                break;
            }
        }
    }
    None
}

/// Resolve the (program, args) to spawn for the Node sidecar.
fn resolve_launch_command() -> Result<(String, Vec<String>)> {
    if let Ok(explicit) = env::var("GRAPHNOSIS_SIDECAR_BIN") {
        // Either a path to node (with args) or a direct executable.
        if explicit.ends_with(".js") {
            return Ok((
                node_path()?.to_string_lossy().into_owned(),
                vec![explicit],
            ));
        }
        return Ok((explicit, vec![]));
    }

    // Dev path: workspace at <repo>/apps/desktop-sidecar/dist/index.js
    if let Some(dist) = find_workspace_sidecar_dist() {
        let node = node_path()?.to_string_lossy().into_owned();
        return Ok((node, vec![dist.to_string_lossy().into_owned()]));
    }

    bail!(
        "Could not locate the Graphnosis sidecar. \
         Run `pnpm -r build` in the workspace first, or set GRAPHNOSIS_SIDECAR_BIN to a built sidecar."
    );
}

/// Walk up from the current executable to find the workspace dist file.
/// In `tauri dev`, the executable lives in `target/debug/graphnosis-app`.
/// In a packaged app, this returns None and the bundled sidecar path takes over
/// (TODO once we ship a packaged build).
fn find_workspace_sidecar_dist() -> Option<PathBuf> {
    // Walk up from the manifest dir (src-tauri/) to find the workspace root.
    // Tauri sets CARGO_MANIFEST_DIR at build time, but at runtime we infer from the exe.
    if let Ok(exe) = env::current_exe() {
        let mut cur = exe.parent()?.to_path_buf();
        // From target/debug/<bin>: parent is target, parent.parent is src-tauri, etc.
        for _ in 0..6 {
            let candidate = cur
                .join("apps")
                .join("desktop-sidecar")
                .join("dist")
                .join("index.js");
            if candidate.exists() {
                return Some(candidate);
            }
            if let Some(p) = cur.parent() {
                cur = p.to_path_buf();
            } else {
                break;
            }
        }
    }
    None
}

/// Locate the `node` binary. Tauri apps launched from Finder/launchd have a
/// minimal PATH, so we check common nvm + Homebrew locations.
fn node_path() -> Result<PathBuf> {
    if let Some(home) = dirs::home_dir() {
        // Prefer the nvm-managed Node the user has installed.
        let nvm_versions = home.join(".nvm").join("versions").join("node");
        if let Ok(entries) = std::fs::read_dir(&nvm_versions) {
            // Pick the highest-numbered v20.x or v22.x present.
            let mut best: Option<PathBuf> = None;
            for e in entries.flatten() {
                let name = e.file_name();
                let n = name.to_string_lossy();
                if n.starts_with("v20.") || n.starts_with("v22.") {
                    let p = e.path().join("bin").join("node");
                    if p.exists() {
                        best = Some(match best {
                            None => p,
                            Some(prev) => if p > prev { p } else { prev },
                        });
                    }
                }
            }
            if let Some(p) = best { return Ok(p); }
        }
    }
    for candidate in [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ] {
        let p = PathBuf::from(candidate);
        if p.exists() {
            return Ok(p);
        }
    }
    bail!("could not find node binary on PATH or in common locations");
}

