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
//! After spawn, we wait up to 90s for the sidecar's Unix socket to appear,
//! which indicates IPC is up. If it doesn't appear, we report a clear error
//! so the unlock flow doesn't pretend everything's fine.

use std::collections::VecDeque;
use std::env;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::time::sleep;
// Windows: needed for cmd.creation_flags(CREATE_NO_WINDOW) to suppress the
// console window that would otherwise pop up alongside the sidecar.
#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Payload emitted on `graphnosis://sidecar-boot-status` during startup.
/// The UI listens for this and shows the step in the lock screen.
#[derive(Serialize, Clone)]
struct BootStatus<'a> {
    step: &'a str,
    detail: &'a str,
}

/// How many of the sidecar's most-recent stderr lines we keep, so we can
/// classify startup failures by their actual log output. 200 is enough to
/// catch a full Node stack trace from the FATAL line through the exception.
const STDERR_BUFFER_LINES: usize = 200;

pub struct SidecarHandle {
    child: Child,
    pub socket_path: PathBuf,
    pub events_socket_path: PathBuf,
    /// Ring buffer of the sidecar's most-recent stderr lines. Used for
    /// classifying startup failures into friendlier user-facing messages
    /// even when the process dies via signal (no clean exit code).
    _stderr_buffer: Arc<Mutex<VecDeque<String>>>,
}

impl SidecarHandle {
    pub async fn shutdown(mut self) -> Result<()> {
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
        // Sidecar releases its cortex lock on SIGTERM; we also tidy the socket files.
        // On Windows the "paths" are TCP addresses — nothing to remove from disk.
        #[cfg(unix)]
        {
            let _ = std::fs::remove_file(&self.socket_path);
            let _ = std::fs::remove_file(&self.events_socket_path);
        }
        Ok(())
    }
}

/// Allocate a free loopback port by binding to port 0 and immediately
/// releasing the listener. Used on Windows where Unix sockets are unavailable.
#[cfg(windows)]
fn alloc_local_port() -> Result<u16> {
    use std::net::TcpListener;
    let l = TcpListener::bind("127.0.0.1:0")
        .context("allocate local TCP port for IPC")?;
    Ok(l.local_addr()?.port())
}

pub async fn start(app: &AppHandle, cortex_dir: &Path, passphrase: &str, preferred_default_graph: Option<&str>) -> Result<SidecarHandle> {
    start_inner(app, cortex_dir, passphrase, None, preferred_default_graph).await
}

/// Start the sidecar in recovery mode: the user has their 24-word BIP-39
/// phrase but has forgotten the passphrase. The sidecar reads `recovery.enc`
/// from the cortex dir and decrypts it with this phrase to recover the data key.
pub async fn start_with_recovery(app: &AppHandle, cortex_dir: &Path, recovery_phrase: &str, preferred_default_graph: Option<&str>) -> Result<SidecarHandle> {
    start_inner(app, cortex_dir, "", Some(recovery_phrase), preferred_default_graph).await
}

async fn start_inner(app: &AppHandle, cortex_dir: &Path, passphrase: &str, recovery_phrase: Option<&str>, preferred_default_graph: Option<&str>) -> Result<SidecarHandle> {
    // On Unix: Unix domain sockets in the cortex directory.
    // On Windows: TCP loopback ports (UnixStream is not available).
    #[cfg(unix)]
    let (socket_path, events_socket_path) = (
        cortex_dir.join("sidecar.sock"),
        cortex_dir.join("events.sock"),
    );
    #[cfg(windows)]
    let (socket_path, events_socket_path) = {
        let ipc_port = alloc_local_port()?;
        let evt_port = alloc_local_port()?;
        (
            PathBuf::from(format!("127.0.0.1:{}", ipc_port)),
            PathBuf::from(format!("127.0.0.1:{}", evt_port)),
        )
    };

    // cortex-independent MCP listener socket (see mcp_socket_path) — the path
    // external clients bake into their config, stable across cortex switches.
    let mcp_socket = mcp_socket_path()?;
    // Stale socket left by a previous orphan? Remove it; the sidecar would recreate
    // it cleanly, but having it pre-existing can mask the "is the new sidecar up?" check.
    #[cfg(unix)]
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
        // Fixed, cortex-independent path so a client configured once stays
        // connected across every cortex folder (see mcp_socket_path).
        .env("GRAPHNOSIS_MCP_SOCKET", &mcp_socket)
        // Default graph: prefer the user's last-active engram from localStorage
        // (passed in by the unlock command) so the lock screen "Loading
        // memories…" loads the engram the user actually wants to see, instead
        // of always loading "personal" first and then swapping later. Falls
        // back to "personal" when no preference is set (first run, fresh
        // install). The sidecar's startup graceful-create only triggers on
        // ENOENT, so passing a missing graphId would create it — guarded
        // by validation upstream in unlock_cortex.
        .env(
            "GRAPHNOSIS_DEFAULT_GRAPH",
            preferred_default_graph.unwrap_or("personal"),
        )
        .env("GRAPHNOSIS_EVENTS_SOCKET", &events_socket_path);
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

    // Windows: suppress the console window that would otherwise pop up
    // alongside the sidecar. CREATE_NO_WINDOW (0x08000000) tells CreateProcess
    // to not allocate a console for the child. Piping above still captures
    // stdout/stderr — only the visible terminal window is suppressed.
    // build.rs ALSO compiles the Bun binary with --windows-hide-console so it
    // declares the Windows GUI subsystem at PE level; this flag is the
    // defence-in-depth case for older binaries already shipped to users.
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);

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
    // just returns. Also emits boot-status Tauri events for known startup
    // phrases so the lock screen can show progress during long cortex loads.
    let stderr_buffer: Arc<Mutex<VecDeque<String>>> =
        Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_BUFFER_LINES)));
    if let Some(stderr) = child.stderr.take() {
        let buffer = stderr_buffer.clone();
        let app_inner = app.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("{}", line);
                if let Ok(mut buf) = buffer.lock() {
                    if buf.len() >= STDERR_BUFFER_LINES {
                        buf.pop_front();
                    }
                    buf.push_back(line.clone());
                }
                // Emit recognisable startup milestones to the frontend so the
                // lock screen can show progress instead of a spinning bar.
                let status: Option<BootStatus> = if line.contains("cortex lock acquired") {
                    Some(BootStatus { step: "lock", detail: "Cortex secured" })
                } else if line.contains("local embeddings ready") {
                    Some(BootStatus { step: "embeddings", detail: "AI embeddings ready" })
                } else if line.contains("WARNING: local embeddings unavailable") {
                    Some(BootStatus { step: "embeddings", detail: "Starting (text search only)" })
                } else if line.contains("loaded engram") {
                    Some(BootStatus { step: "engram", detail: "Loading memories…" })
                } else if line.contains("IPC listening") {
                    Some(BootStatus { step: "ready", detail: "Ready" })
                } else {
                    None
                };
                if let Some(s) = status {
                    let _ = app_inner.emit("graphnosis://sidecar-boot-status", s);
                }
            }
        });
    }

    // Wait for either the IPC socket to appear OR the child process to exit.
    // 90s covers large cortexes (4000+ nodes with BGE embeddings can take
    // 30–60s on first decrypt+load). Exit-during-startup commonly means:
    // wrong passphrase, missing env var, or a fatal Node error — we surface
    // that as a meaningful error instead of making the user wait the full
    // timeout for a soft failure.
    let _ = app.emit("graphnosis://sidecar-boot-status", BootStatus {
        step: "starting",
        detail: "Starting Graphnosis…",
    });
    let start = std::time::Instant::now();
    let max = Duration::from_secs(90);
    let mut last_tick_s: u64 = 0;
    loop {
        // On Unix: wait for the socket file to appear.
        // On Windows: socket_path is a TCP address — probe with a quick connect.
        #[cfg(unix)]
        let ready = socket_path.exists();
        #[cfg(windows)]
        let ready = {
            let addr = socket_path.to_string_lossy().to_string();
            std::net::TcpStream::connect_timeout(
                &addr.parse().unwrap_or(std::net::SocketAddr::from(([127, 0, 0, 1], 0))),
                Duration::from_millis(50),
            ).is_ok()
        };
        if ready {
            break;
        }
        // Emit a generic "still loading" heartbeat every 5s so the UI
        // knows the sidecar is alive even between recognised stderr lines.
        let elapsed_s = start.elapsed().as_secs();
        if elapsed_s / 5 > last_tick_s / 5 {
            last_tick_s = elapsed_s;
            let _ = app.emit("graphnosis://sidecar-boot-status", BootStatus {
                step: "loading",
                detail: "Loading cortex…",
            });
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
                "sidecar did not start cleanly within 90s: socket {} did not appear. \
                 Check the dev terminal for stderr.",
                socket_path.display()
            ));
        }
        sleep(Duration::from_millis(150)).await;
    }

    Ok(SidecarHandle {
        child,
        socket_path,
        events_socket_path,
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
    // cortex lock held by a competing process.
    if stderr_tail.contains("FATAL: could not acquire cortex lock")
        || stderr_tail.contains("another Graphnosis sidecar is already writing to this cortex")
    {
        return "Another Graphnosis synapse is already holding this cortex's lock. \
                Quit any other Graphnosis instance (including Claude Desktop's MCP server \
                if it spawns its own synapse), then try again. If the lock persists, quit \
                any leftover `graphnosis-sidecar` process from Activity Monitor."
            .to_string();
    }
    // Missing env var, missing node binary, etc. — bubble up.
    if stderr_tail.contains("Missing env var") {
        return format!("Synapse reported a missing configuration value. \
                        (synapse exit code {})\n\nSynapse stderr:\n{}",
                       exit_code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".to_string()),
                       trimmed_stderr_for_display(stderr_tail));
    }
    // Generic fallback — appends the actual stderr tail so users can debug
    // without dev tools. In production .app builds the user has no terminal
    // to "check"; the only way they ever see the real error is if we put it
    // in the message itself.
    let display_tail = trimmed_stderr_for_display(stderr_tail);
    let suffix = if display_tail.is_empty() {
        String::new()
    } else {
        format!("\n\nSynapse stderr (last lines):\n{}", display_tail)
    };
    match exit_code {
        Some(2) => format!(
            "Another Graphnosis synapse is already holding this cortex's lock. \
             Quit it and try again.{}",
            suffix,
        ),
        Some(1) => format!(
            "Synapse failed during startup. \
             Most likely cause: wrong passphrase or a corrupted cortex file.{}",
            suffix,
        ),
        _ => format!(
            "Synapse exited unexpectedly during startup. (exit code {}){}",
            exit_code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".to_string()),
            suffix,
        ),
    }
}

/// Trim sidecar stderr for inclusion in a user-facing error message.
///
/// Production users have no terminal to "check the dev logs" — so when a
/// startup failure can't be classified into a friendly canned message, we
/// include the raw stderr tail in the error itself. This is the only way
/// they (or we, debugging remotely) ever see the real cause.
///
/// Cap at ~1.5 KB so the error stays readable when shown in a dialog,
/// and trim leading log noise (worker-spawn messages etc.) so the
/// actual error line is more likely to be visible.
fn trimmed_stderr_for_display(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    const MAX_BYTES: usize = 1500;
    if trimmed.len() <= MAX_BYTES {
        return trimmed.to_string();
    }
    // Keep the tail — fatal errors land at the end. Marker so the user
    // knows they're seeing a truncated view.
    let cut_from = trimmed.len() - MAX_BYTES;
    let tail = &trimmed[cut_from..];
    format!("…[earlier output truncated]…\n{}", tail)
}

/// Fixed, cortex-independent filesystem path for the sidecar's MCP listener
/// socket — `~/.graphnosis/mcp.sock`.
///
/// This path MUST NOT live inside the cortex folder. External MCP clients
/// (Claude Desktop, Claude Code, Cursor) bake this exact path into their own
/// global config when the user clicks "Connect", and only one sidecar runs at
/// a time. A per-cortex path silently broke every configured client the
/// moment the user opened a different cortex folder — a single stable path
/// means one "Connect" keeps working across every cortex.
///
/// Kept short on purpose: macOS caps Unix socket paths at ~104 bytes, and
/// `~/Library/Application Support/...` would eat most of that. The sidecar's
/// MCP server `mkdir -p`s the parent directory before binding.
///
/// Mac App Store note: under the App Sandbox `~/.graphnosis/` is NOT writable
/// (the current Developer ID / notarized build is unsandboxed, so it is fine
/// there). A future sandboxed MAS build must revisit this — the sandbox
/// container path is itself too long for `sun_path`, so MAS likely needs a
/// localhost-TCP MCP transport instead of a filesystem socket. This function
/// is the single place that decision has to land.
pub fn mcp_socket_path() -> Result<PathBuf> {
    let home = dirs::home_dir()
        .ok_or_else(|| anyhow!("could not resolve the home directory for the MCP socket path"))?;
    Ok(home.join(".graphnosis").join("mcp.sock"))
}

/// Resolve the path to the compiled MCP relay binary.
///
/// Returns the binary path so callers (`configure_claude_desktop`) can
/// write Claude's mcp.json config to spawn it directly — no Node required
/// on the user's machine.
///
/// Resolution order matches `resolve_sidecar_path`:
///   1. `$GRAPHNOSIS_RELAY_BIN` override
///   2. `<exe-dir>/graphnosis-mcp-relay` — production .app bundles (Tauri
///      strips the `-<host-triple>` suffix during externalBin bundling)
///   3. `<exe-dir>/graphnosis-mcp-relay-<host-triple>` — dev builds where
///      build.rs's `ensure_runtime_copy_named` copies the suffixed name
pub fn resolve_relay_path() -> Result<PathBuf> {
    if let Ok(explicit) = env::var("GRAPHNOSIS_RELAY_BIN") {
        let p = PathBuf::from(explicit);
        if p.exists() { return Ok(p); }
        bail!("$GRAPHNOSIS_RELAY_BIN points at {} which does not exist", p.display());
    }
    let exe = env::current_exe().context("env::current_exe")?;
    let exe_dir = exe.parent().context("exe parent dir")?;
    let triple = host_target_triple();
    // Production .app first (Tauri strips the triple suffix on externalBin
    // bundling), then dev's suffixed name as fallback. EXE_SUFFIX is ".exe"
    // on Windows and "" elsewhere — without it, Windows installs fail to find
    // the bundled `graphnosis-mcp-relay.exe`.
    let bundled = exe_dir.join(format!("graphnosis-mcp-relay{}", env::consts::EXE_SUFFIX));
    if bundled.exists() {
        return Ok(bundled);
    }
    let dev = exe_dir.join(format!("graphnosis-mcp-relay-{}{}", triple, env::consts::EXE_SUFFIX));
    if dev.exists() {
        return Ok(dev);
    }
    bail!(
        "Could not locate the Graphnosis MCP relay binary. \
         Expected at {} (production bundle) or {} (dev build). \
         Run `pnpm --filter @graphnosis-app/desktop tauri:build` (which invokes \
         build.rs → bun --compile), or set GRAPHNOSIS_RELAY_BIN.",
        bundled.display(),
        dev.display(),
    )
}

/// Resolve the path to the compiled sidecar binary.
///
/// Order:
///   1. `$GRAPHNOSIS_SIDECAR_BIN` — explicit override. Lets devs point at
///      a hand-built binary without rebuilding the Tauri shell.
///   2. `<exe-dir>/graphnosis-sidecar` — production .app bundles. Tauri's
///      externalBin packaging strips the `-<host-triple>` suffix when it
///      copies the binary into `Contents/MacOS/`, so the file lives next
///      to the main app binary under its base name.
///   3. `<exe-dir>/graphnosis-sidecar-<host-triple>` — dev / `tauri dev`
///      builds where build.rs's `ensure_runtime_copy_named` keeps the
///      suffixed name in `target/<profile>/`.
fn resolve_sidecar_path() -> Result<PathBuf> {
    if let Ok(explicit) = env::var("GRAPHNOSIS_SIDECAR_BIN") {
        let p = PathBuf::from(explicit);
        if p.exists() { return Ok(p); }
        bail!("$GRAPHNOSIS_SIDECAR_BIN points at {} which does not exist", p.display());
    }
    let exe = env::current_exe().context("env::current_exe")?;
    let exe_dir = exe.parent().context("exe parent dir")?;
    let triple = host_target_triple();
    // Production .app first (Tauri strips the triple suffix on bundling),
    // then dev's suffixed name as fallback. EXE_SUFFIX is ".exe" on Windows
    // and "" elsewhere — without it, Windows installs fail to find the
    // bundled `graphnosis-sidecar.exe` and the lock screen reports
    // "could not locate the sidecar binary".
    let bundled = exe_dir.join(format!("graphnosis-sidecar{}", env::consts::EXE_SUFFIX));
    if bundled.exists() {
        return Ok(bundled);
    }
    let dev = exe_dir.join(format!("graphnosis-sidecar-{}{}", triple, env::consts::EXE_SUFFIX));
    if dev.exists() {
        return Ok(dev);
    }
    bail!(
        "Could not locate the Graphnosis sidecar binary. \
         Expected at {} (production bundle) or {} (dev build). \
         Run `pnpm --filter @graphnosis-app/desktop tauri:build` (which invokes \
         build.rs → bun --compile), or set GRAPHNOSIS_SIDECAR_BIN to an explicit path.",
        bundled.display(),
        dev.display(),
    )
}

/// Build a colon-separated list of directories where dyld should look for
/// shared libraries that fastembed's native modules load via @rpath but
/// that Bun's --compile didn't extract alongside the .node file.
///
/// Includes (in priority order):
///   1. The directory containing the sidecar binary itself — covers dev
///      mode (target/<profile>/) where build.rs copies the dylib.
///   2. `../Resources/` relative to the sidecar binary — bundled .app
///      where Tauri puts resource files. `Contents/MacOS/<binary>` sits
///      next to `Contents/Resources/`.
///   3. `../Resources/resources/` — same bundled layout when tauri.conf.json
///      declares resources with a path prefix (e.g.
///      `"resources/libonnxruntime.1.21.0.dylib"`), Tauri preserves the
///      `resources/` segment inside `Contents/Resources/`. dyld doesn't
///      recurse so we have to add this nested dir explicitly.
///
/// Returns an empty string if the sidecar path can't be resolved; callers
/// skip setting the env var in that case (better to let dyld error
/// honestly than seed an invalid path).
fn compose_dyld_search_path(binary: &Path) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(dir) = binary.parent() {
        parts.push(dir.to_string_lossy().into_owned());
        // `<exe-dir>/../Resources` and its nested `resources/` — bundled
        // .app layout. We add both because Tauri preserves the resource
        // path prefix from tauri.conf.json's "resources" array.
        if let Some(grandparent) = dir.parent() {
            let resources = grandparent.join("Resources");
            if resources.exists() {
                parts.push(resources.to_string_lossy().into_owned());
                let nested = resources.join("resources");
                if nested.exists() {
                    parts.push(nested.to_string_lossy().into_owned());
                }
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

