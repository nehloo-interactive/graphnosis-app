//! Spawns and supervises the Node sidecar process.
//!
//! Resolution order for the sidecar binary:
//!   1. $GRAPHNOSIS_SIDECAR_BIN env var — full path to a binary (compiled
//!      Bun output OR a Node script). Lets devs hot-swap a sidecar build
//!      without rebuilding the Tauri shell.
//!   2. Tauri externalBin convention: `<exe-dir>/graphnosis-sidecar-<triple>`.
//!      In a bundled .app that's `Graphnosis.app/Contents/MacOS/`; in
//!      `tauri dev` it's `target/<profile>/` (build.rs copies the compiled
//!      Bun binary there).
//!
//! The legacy "Node + workspace dist" path that walked up from current_exe
//! looking for `apps/desktop-sidecar/dist/index.js` was removed when we
//! switched to Bun-compiled single-binary sidecars (v0.0.1+). It only ever
//! worked inside the dev tree and broke as soon as the .app was moved out
//! of the workspace.
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
        // Sidecar releases its cortex lock on SIGTERM; we also tidy the socket file.
        let _ = std::fs::remove_file(&self.socket_path);
        Ok(())
    }
}

pub async fn start(cortex_dir: &Path, passphrase: &str) -> Result<SidecarHandle> {
    start_inner(cortex_dir, passphrase, None).await
}

/// Start the sidecar in recovery mode: the user has their 24-word BIP-39
/// phrase but has forgotten the passphrase. The sidecar reads `recovery.enc`
/// from the cortex dir and decrypts it with this phrase to recover the data key.
pub async fn start_with_recovery(cortex_dir: &Path, recovery_phrase: &str) -> Result<SidecarHandle> {
    start_inner(cortex_dir, "", Some(recovery_phrase)).await
}

async fn start_inner(cortex_dir: &Path, passphrase: &str, recovery_phrase: Option<&str>) -> Result<SidecarHandle> {
    let socket_path = cortex_dir.join("sidecar.sock");
    // Stale socket left by a previous orphan? Remove it; the sidecar would recreate
    // it cleanly, but having it pre-existing can mask the "is the new sidecar up?" check.
    let _ = std::fs::remove_file(&socket_path);

    let binary = resolve_sidecar_path()?;

    // Compose the DYLD search path for the native shared libraries that
    // fastembed's onnxruntime-node binding pulls in via @rpath. Bun's
    // --compile extracts the .node addon to a temp dir but not the sibling
    // libonnxruntime.dylib — dyld's @rpath lookup against the temp dir
    // therefore fails and embeddings degrade to TF-IDF only. Pointing
    // DYLD_FALLBACK_LIBRARY_PATH at the directories where build.rs places
    // the dylib (dev: target/<profile>/, bundled: Contents/Resources/)
    // lets dyld's fallback search find it. See build.rs's
    // `copy_onnxruntime_dylib` for the source side.
    let dyld_search_path = compose_dyld_search_path(&binary);

    let mut cmd = Command::new(&binary);
    cmd
        .env("GRAPHNOSIS_CORTEX", cortex_dir)
        .env("GRAPHNOSIS_IPC_SOCKET", &socket_path)
        // Default graph; the App could later make this user-configurable.
        .env("GRAPHNOSIS_DEFAULT_GRAPH", "personal");
    if !dyld_search_path.is_empty() {
        #[cfg(target_os = "macos")]
        cmd.env("DYLD_FALLBACK_LIBRARY_PATH", &dyld_search_path);
        #[cfg(target_os = "linux")]
        cmd.env("LD_LIBRARY_PATH", &dyld_search_path);
    }
    cmd
        .stdin(Stdio::null())
        // Pipe stderr so we can: (a) mirror it to OUR stderr (dev terminal
        // still sees logs), and (b) keep a small ring buffer for classifying
        // startup failures. Inherit alone hid the lines from us, which made
        // "wrong passphrase" indistinguishable from "cortex lock held" in the
        // UI when the sidecar died via signal.
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // Recovery mode sets GRAPHNOSIS_RECOVERY_PHRASE; normal mode sets
    // GRAPHNOSIS_PASSPHRASE. The sidecar reads whichever is present.
    if let Some(rp) = recovery_phrase {
        cmd.env("GRAPHNOSIS_RECOVERY_PHRASE", rp);
    } else {
        cmd.env("GRAPHNOSIS_PASSPHRASE", passphrase);
    }

    let mut child = cmd
        .spawn()
        .with_context(|| format!("spawn sidecar ({})", binary.display()))?;

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
    // (sidecar refused to overwrite an existing cortex), missing env var, or
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
                If you're certain the passphrase is right, the cortex file may have been \
                corrupted — restore from a backup if you have one."
            .to_string();
    }
    // Wrong or missing recovery phrase (24-word BIP-39).
    // These surface as a fatal at open() before any graph is loaded, so they
    // lack the "FATAL: failed to load existing graph:" prefix that passphrase
    // errors carry. We match the specific messages from host.ts open().
    if stderr_tail.contains("Cannot recover: recovery.enc not found") {
        return "No recovery phrase backup found in this cortex folder. \
                Recovery is only available for cortexes created with Graphnosis v0.2.x or later."
            .to_string();
    }
    if stderr_tail.contains("Cannot recover: cortex salt.bin not found") {
        return "This cortex does not appear to be initialized yet. Unlock it normally first."
            .to_string();
    }
    // Wrong recovery phrase → libsodium decrypt throws. The error does NOT
    // carry "FATAL: failed to load existing graph:" so we can distinguish it
    // from a wrong passphrase (which does carry that prefix).
    if stderr_tail.contains("Decryption failed (wrong passphrase or tampered file)")
        && !stderr_tail.contains("FATAL: failed to load existing graph:")
    {
        return "Wrong recovery phrase. Check every word carefully — order matters — and try again."
            .to_string();
    }
    // Cortex lock held by a competing process.
    if stderr_tail.contains("FATAL: could not acquire cortex lock")
        || stderr_tail.contains("another Graphnosis sidecar is already writing to this cortex")
    {
        return "Another Graphnosis synapse is already holding this cortex's lock. \
                Quit any other Graphnosis instance (including Claude Desktop's MCP server \
                if it spawns its own synapse), or run \
                `pkill -f apps/desktop-sidecar/dist/index.js` to clear orphans, then try again."
            .to_string();
    }
    // Missing env var, missing node binary, etc. — bubble up.
    if stderr_tail.contains("Missing env var") {
        return format!("Synapse reported a missing configuration value. \
                        Check the terminal running `pnpm dev:desktop` for details. \
                        (synapse exit code {})",
                       exit_code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".to_string()));
    }
    // Generic fallback — still informative, with the exit code if we have it.
    match exit_code {
        Some(2) => "Another Graphnosis synapse is already holding this cortex's lock. \
                    Quit it and try again."
            .to_string(),
        Some(1) => "Synapse failed during startup. \
                    Most likely cause: wrong passphrase or a corrupted cortex file. \
                    Check the terminal running `pnpm dev:desktop` for the synapse's stderr."
            .to_string(),
        _ => format!("Synapse exited unexpectedly during startup. \
                      Check the terminal running `pnpm dev:desktop` for the synapse's stderr. \
                      (exit code {})",
                     exit_code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".to_string())),
    }
}

/// Resolve the path to the compiled MCP relay binary.
///
/// Returns the binary path so callers (`configure_claude_desktop`) can
/// write Claude's mcp.json config to spawn it directly — no Node required
/// on the user's machine.
///
/// Resolution order matches `resolve_sidecar_path`:
///   1. `$GRAPHNOSIS_RELAY_BIN` override
///   2. `<exe-dir>/graphnosis-mcp-relay-<host-triple>`
pub fn resolve_relay_path() -> Result<PathBuf> {
    if let Ok(explicit) = env::var("GRAPHNOSIS_RELAY_BIN") {
        let p = PathBuf::from(explicit);
        if p.exists() { return Ok(p); }
        bail!("$GRAPHNOSIS_RELAY_BIN points at {} which does not exist", p.display());
    }
    let exe = env::current_exe().context("env::current_exe")?;
    let exe_dir = exe.parent().context("exe parent dir")?;
    let triple = host_target_triple();
    let candidate = exe_dir.join(format!("graphnosis-mcp-relay-{}", triple));
    if candidate.exists() {
        return Ok(candidate);
    }
    bail!(
        "Could not locate the Graphnosis MCP relay binary. \
         Expected at: {}. \
         Run `pnpm --filter @graphnosis-app/desktop tauri build` (which invokes \
         build.rs → bun --compile), or set GRAPHNOSIS_RELAY_BIN.",
        candidate.display()
    )
}

/// Resolve the path to the compiled sidecar binary.
///
/// Order:
///   1. `$GRAPHNOSIS_SIDECAR_BIN` — explicit override. Lets devs point at
///      a hand-built binary without rebuilding the Tauri shell.
///   2. `<exe-dir>/graphnosis-sidecar-<host-triple>` — Tauri's externalBin
///      convention. In a bundled .app the file sits next to the main
///      binary in `Contents/MacOS/`; in `tauri dev` it sits in
///      `target/<profile>/` (placed there by build.rs's
///      `ensure_runtime_copy_named`).
fn resolve_sidecar_path() -> Result<PathBuf> {
    if let Ok(explicit) = env::var("GRAPHNOSIS_SIDECAR_BIN") {
        let p = PathBuf::from(explicit);
        if p.exists() { return Ok(p); }
        bail!("$GRAPHNOSIS_SIDECAR_BIN points at {} which does not exist", p.display());
    }
    let exe = env::current_exe().context("env::current_exe")?;
    let exe_dir = exe.parent().context("exe parent dir")?;
    let triple = host_target_triple();
    let candidate = exe_dir.join(format!("graphnosis-sidecar-{}", triple));
    if candidate.exists() {
        return Ok(candidate);
    }
    bail!(
        "Could not locate the Graphnosis sidecar binary. \
         Expected at: {}. \
         Run `pnpm --filter @graphnosis-app/desktop tauri build` (which invokes \
         build.rs → bun --compile), or set GRAPHNOSIS_SIDECAR_BIN to an explicit path.",
        candidate.display()
    )
}

/// Build a colon-separated list of directories where dyld should look for
/// shared libraries that fastembed's native modules load via @rpath but
/// that Bun's --compile didn't extract alongside the .node file.
///
/// Includes (in priority order):
///   1. The directory containing the sidecar binary itself — covers dev
///      mode (target/<profile>/) where build.rs copies the dylib.
///   2. `../Resources/` relative to the sidecar binary — covers bundled
///      .app where Tauri puts resource files. `Contents/MacOS/<binary>`
///      sits next to `Contents/Resources/`.
///
/// Returns an empty string if the sidecar path can't be resolved; callers
/// skip setting the env var in that case (better to let dyld error
/// honestly than seed an invalid path).
fn compose_dyld_search_path(binary: &Path) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(dir) = binary.parent() {
        parts.push(dir.to_string_lossy().into_owned());
        // `<exe-dir>/../Resources` — bundled .app layout.
        if let Some(grandparent) = dir.parent() {
            let resources = grandparent.join("Resources");
            if resources.exists() {
                parts.push(resources.to_string_lossy().into_owned());
            }
        }
    }
    parts.join(":")
}

/// Compile-time host target triple. Matches the value `cargo` sets for the
/// `TARGET` env var during build.rs execution. We hard-code via cfg
/// attributes rather than reading $TARGET at runtime because cargo doesn't
/// surface it to the running binary — and at runtime we already know the
/// platform we were compiled for.
const fn host_target_triple() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    { "aarch64-apple-darwin" }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    { "x86_64-apple-darwin" }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    { "aarch64-unknown-linux-gnu" }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    { "x86_64-unknown-linux-gnu" }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    { "x86_64-pc-windows-msvc" }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "x86_64"),
    )))]
    { "unknown" }
}

// Note: a `node_path()` helper used to live here for the MCP relay's
// `node + relay.js` spawn pattern. Since the MCP relay was bun-compiled
// to a standalone binary (`graphnosis-mcp-relay-<triple>`), Claude Desktop
// no longer needs system Node — the helper was deleted alongside the
// `resolve_node_and_relay()` function that used it.

