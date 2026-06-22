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
    /// Cortex directory this sidecar is locked to. Stored so shutdown() can
    /// remove the proper-lockfile lock file directly — child.kill() sends
    /// SIGKILL (not SIGTERM), so the sidecar's SIGTERM handler never runs and
    /// proper-lockfile never gets a chance to release the lock on its own.
    cortex_dir: PathBuf,
    /// Raw OS PID captured at spawn time. Stored separately from `child` so
    /// the synchronous `Drop` impl can send SIGKILL without needing the tokio
    /// runtime to be alive. `child.id()` returns None once the child has been
    /// waited on, but we need the PID even if `shutdown()` already ran
    /// (a double-kill on an exited process is a harmless ESRCH).
    raw_pid: Option<u32>,
    /// Ring buffer of the sidecar's most-recent stderr lines. Used for
    /// classifying startup failures into friendlier user-facing messages
    /// even when the process dies via signal (no clean exit code).
    _stderr_buffer: Arc<Mutex<VecDeque<String>>>,
}

/// Reap embed-worker child processes that outlive a SIGKILL'd sidecar parent.
/// Compiled workers re-exec the same `graphnosis-sidecar` binary; dev smoke
/// runs fork `embed-worker.js` — sweep both patterns. Safe after graceful
/// shutdown (workers already terminated) and on quit (main sidecar is dead).
#[cfg(unix)]
fn kill_orphan_embed_workers() {
    for pattern in ["graphnosis-sidecar", "embed-worker"] {
        let _ = std::process::Command::new("pkill")
            .args(["-9", "-f", pattern])
            .output();
    }
}

impl Drop for SidecarHandle {
    /// Synchronous last-resort kill — fires whenever the handle is dropped,
    /// including on abnormal Tauri exit where the tokio runtime shuts down
    /// before `shutdown()` is called. `kill_on_drop(true)` on the tokio
    /// `Child` is NOT reliable in that scenario: tokio's drop glue requires
    /// a running runtime to schedule the async kill, and if the runtime is
    /// already torn down the sidecar simply becomes an orphan.
    ///
    /// A direct libc `kill(pid, SIGKILL)` syscall has no such dependency —
    /// it works from any thread, runtime or not. On an already-exited process
    /// it returns ESRCH (no-op), so calling it after a graceful `shutdown()`
    /// is harmless. Socket and lockfile removal are best-effort for the same
    /// reason — `shutdown()` may have already cleaned them up.
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.raw_pid {
            // SAFETY: kill(2) is always safe to call with a valid pid and a
            // known signal constant. SIGKILL = 9 on all POSIX targets.
            extern "C" { fn kill(pid: i32, sig: i32) -> i32; }
            unsafe { kill(pid as i32, 9); }
        }
        #[cfg(unix)]
        kill_orphan_embed_workers();
        // Remove the lockfile synchronously — no runtime needed.
        let lock_file = self.cortex_dir.join(".lockfile.lock");
        let _ = std::fs::remove_dir(&lock_file);
        // Socket cleanup (Unix only). On Windows "socket paths" are TCP
        // addresses — nothing to remove from disk.
        #[cfg(unix)]
        {
            let _ = std::fs::remove_file(&self.socket_path);
            let _ = std::fs::remove_file(&self.events_socket_path);
        }
    }
}

impl SidecarHandle {
    /// OS PID captured at spawn time — used by the exit watchdog in lib.rs.
    pub fn pid(&self) -> Option<u32> {
        self.raw_pid
    }

    pub async fn shutdown(mut self) -> Result<()> {
        // Ask the sidecar to flush dirty graphs and exit cleanly. On Unix we
        // send SIGTERM and wait up to 3 s; if it doesn't respond we fall back
        // to SIGKILL. On Windows there is no SIGTERM — go straight to kill().
        #[cfg(unix)]
        {
            if let Some(pid) = self.child.id() {
                // SAFETY: kill(2) is always safe to call with a valid pid and
                // a known signal number. SIGTERM = 15.
                extern "C" { fn kill(pid: i32, sig: i32) -> i32; }
                unsafe { kill(pid as i32, 15); }
            }
            // Wait up to 45 s for the sidecar's graceful-shutdown path to
            // complete (flush graphs, release lock, exit). The default was 3 s,
            // but a Purge operation re-ingests every live source sequentially —
            // on a large cortex that can take 30+ seconds. Killing too soon
            // leaves a zombie holding port 3457 and the events socket, causing
            // EADDRINUSE when the next unlock spawns a fresh sidecar.
            let _ = tokio::time::timeout(Duration::from_secs(45), self.child.wait()).await;
        }
        // SIGKILL fallback: always on Windows, after timeout on Unix. kill()
        // on an already-exited child is a no-op (returns an ignorable error).
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
        #[cfg(unix)]
        kill_orphan_embed_workers();
        // When the sidecar exits via SIGKILL (or didn't handle SIGTERM in
        // time), proper-lockfile never releases `.lockfile.lock`. Delete it
        // here so the next unlock can acquire the lock immediately instead of
        // waiting for the 10s stale timeout (or failing outright).
        // proper-lockfile creates a .lockfile.lock DIRECTORY (atomic mkdir),
        // not a regular file — use remove_dir, not remove_file.
        let lock_file = self.cortex_dir.join(".lockfile.lock");
        let _ = std::fs::remove_dir(&lock_file);
        // Tidy socket files. On Windows the "paths" are TCP addresses —
        // nothing to remove from disk.
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
    start_inner(app, cortex_dir, passphrase, None, None, None, preferred_default_graph).await
}

/// Start the sidecar in recovery mode: the user has their 24-word BIP-39
/// phrase but has forgotten the passphrase. The sidecar reads `recovery.enc`
/// from the cortex dir and decrypts it with this phrase to recover the data key.
pub async fn start_with_recovery(app: &AppHandle, cortex_dir: &Path, recovery_phrase: &str, preferred_default_graph: Option<&str>) -> Result<SidecarHandle> {
    start_inner(app, cortex_dir, "", Some(recovery_phrase), None, None, preferred_default_graph).await
}

/// Enterprise SSO unlock — federated org key + resolved IdP role.
pub async fn start_with_federated_sso(
    app: &AppHandle,
    cortex_dir: &Path,
    federated_unlock_key: &str,
    sso_role: &str,
    sso_email: Option<&str>,
    sso_subject: Option<&str>,
    sso_groups_json: Option<&str>,
    preferred_default_graph: Option<&str>,
) -> Result<SidecarHandle> {
    start_inner(
        app,
        cortex_dir,
        "",
        None,
        Some(federated_unlock_key),
        Some((sso_role, sso_email, sso_subject, sso_groups_json)),
        preferred_default_graph,
    )
    .await
}

type SsoEnv<'a> = (&'a str, Option<&'a str>, Option<&'a str>, Option<&'a str>);

async fn start_inner(
    app: &AppHandle,
    cortex_dir: &Path,
    passphrase: &str,
    recovery_phrase: Option<&str>,
    federated_unlock_key: Option<&str>,
    sso_env: Option<SsoEnv<'_>>,
    preferred_default_graph: Option<&str>,
) -> Result<SidecarHandle> {
    // ── Evict orphaned sidecars ───────────────────────────────────────────────
    // Orphans accumulate when the Tauri shell exits without running Drop
    // (tokio runtime-shutdown race). An orphaned sidecar keeps refreshing the
    // proper-lockfile mtime every 5 s, so the lock never appears stale and the
    // new sidecar fails to start with "cortex lock held". We fix this by:
    //   1. Sending SIGKILL to every running graphnosis-sidecar process.
    //   2. Force-removing the .lockfile.lock directory so the new sidecar
    //      can acquire a fresh lock immediately.
    //
    // This is safe: only one sidecar should ever run per user session — any
    // matching process we find here is by definition an orphan we own. The
    // new sidecar hasn't been spawned yet, so there's no race with it.
    #[cfg(unix)]
    {
        let _ = std::process::Command::new("pkill")
            .args(["-9", "-f", "graphnosis-sidecar"])
            .output();
        // Brief pause: let the kernel reclaim FDs (sockets, lock dir) before
        // we re-bind. SIGKILL is synchronous at the OS level but inode
        // cleanup on macOS/Linux can lag a few ms.
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    // Windows equivalent: taskkill /F terminates processes by image name.
    // Without this, an orphaned sidecar holds .lockfile.lock open; Windows
    // refuses to delete a file held by another process, so remove_file below
    // silently fails, the new sidecar can't acquire the cortex lock, and it
    // exits with code 2 ("cortex lock held"). /T also kills child embed workers
    // spawned by the orphan so they don't linger after the main process dies.
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/IM", "graphnosis-sidecar.exe"])
            .output();
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    // Force-release the cortex lock (Unix dir-based, Windows file-based).
    // Idempotent — remove_dir/remove_file on a non-existent path returns an
    // error we intentionally ignore.
    let lock_path = cortex_dir.join(".lockfile.lock");
    let _ = std::fs::remove_dir(&lock_path);
    #[cfg(windows)]
    let _ = std::fs::remove_file(&lock_path);

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
        .env("GRAPHNOSIS_APP_VERSION", app.package_info().version.to_string())
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
    // Tell the sidecar where the compiled browser UI lives so its optional
    // HTTP UI server (personal-server mode) can serve the real app at `/`
    // instead of the built-in placeholder. The Bun-compiled sidecar can't
    // resolve this itself (its import.meta.url is a virtual-fs path), so the
    // shell resolves it here and passes an absolute path.
    if let Some(ui_dir) = resolve_http_ui_static() {
        cmd.env("GRAPHNOSIS_HTTP_UI_STATIC", &ui_dir);
    }
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
    } else if let Some(fk) = federated_unlock_key {
        cmd.env("GRAPHNOSIS_FEDERATED_UNLOCK_KEY", fk);
        cmd.env("GRAPHNOSIS_PASSPHRASE", "");
    } else {
        cmd.env("GRAPHNOSIS_PASSPHRASE", passphrase);
    }
    if let Some((role, email, subject, groups_json)) = sso_env {
        cmd.env("GRAPHNOSIS_SSO_ROLE", role);
        if let Some(e) = email {
            cmd.env("GRAPHNOSIS_SSO_EMAIL", e);
        }
        if let Some(s) = subject {
            cmd.env("GRAPHNOSIS_SSO_SUBJECT", s);
        }
        if let Some(g) = groups_json {
            cmd.env("GRAPHNOSIS_SSO_GROUPS", g);
        }
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

    let raw_pid = child.id();
    Ok(SidecarHandle {
        child,
        socket_path,
        events_socket_path,
        cortex_dir: cortex_dir.to_path_buf(),
        raw_pid,
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
    // Auto-recovery backstop: the sidecar's loadAllGraphsFromDisk already
    // catches `.gai` integrity failures, quarantines the bad file, and
    // auto-runs applyRecovery() to rebuild from the op-log — in 95% of
    // cases the user never sees this error at all. But if applyRecovery
    // itself fails (op-log also damaged, ran out of disk during rebuild,
    // unrecoverable source), the sidecar exits with code 1 leaving the
    // user staring at the generic "wrong passphrase" fallback. Detect the
    // quarantine marker in the stderr tail and swap in an honest message.
    if stderr_tail.contains("quarantined corrupt engram")
        || stderr_tail.contains("auto-recovery FAILED")
    {
        let display_tail = trimmed_stderr_for_display(stderr_tail);
        let suffix = if display_tail.is_empty() {
            String::new()
        } else {
            format!("\n\nSynapse stderr (last lines):\n{}", display_tail)
        };
        return format!(
            "Graphnosis tried to recover from an interrupted shutdown but couldn't \
             fully rebuild your cortex. One or more engram files were quarantined \
             (moved to .gai.corrupt-<ts> for forensics) and an automatic op-log \
             replay was attempted, but at least one source couldn't be recovered. \
             Your encrypted source content is still safe in the cortex folder. \
             Try: (1) launch Graphnosis again — the recovery pass retries on each \
             boot; (2) if the issue persists, open Settings → Recover from op-log \
             and review the failed-source list. The quarantined files are not \
             deleted — they're kept as .gai.corrupt-<ts> in your cortex's graphs/ \
             folder for manual recovery.{}",
            suffix,
        );
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

/// Resolve the compiled browser-UI directory (index.html + assets) to hand the
/// sidecar via `GRAPHNOSIS_HTTP_UI_STATIC`, so its personal-server HTTP UI can
/// serve the real app instead of a placeholder.
///
/// Order:
///   1. `$GRAPHNOSIS_HTTP_UI_STATIC` — explicit override.
///   2. `<src-tauri>/../dist` — dev source tree (`tauri dev`). The path is
///      baked in at compile time via CARGO_MANIFEST_DIR.
///   3. `<exe-dir>/../Resources/dist` — bundled .app (Tauri copies the
///      `../dist` resource into Contents/Resources/dist).
fn resolve_http_ui_static() -> Option<PathBuf> {
    if let Ok(explicit) = env::var("GRAPHNOSIS_HTTP_UI_STATIC") {
        let p = PathBuf::from(explicit);
        if p.join("index.html").exists() { return Some(p); }
    }
    // Dev: CARGO_MANIFEST_DIR is .../apps/desktop/src-tauri → ../dist.
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("dist");
    if dev.join("index.html").exists() {
        return Some(dev);
    }
    // Production: resource bundled next to the app binary.
    if let Ok(exe) = env::current_exe() {
        if let Some(dir) = exe.parent() {
            let res = dir.join("..").join("Resources").join("dist");
            if res.join("index.html").exists() {
                return Some(res);
            }
        }
    }
    None
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

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct SsoListenerSuccess {
    pub email: Option<String>,
    pub subject: Option<String>,
    pub groups: Vec<String>,
    pub resolved_role: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct SsoListenerOutcome {
    ok: bool,
    reason: Option<String>,
    message: Option<String>,
    email: Option<String>,
    subject: Option<String>,
    groups: Option<Vec<String>>,
    resolved_role: Option<String>,
}

/// Run the pre-unlock OIDC listener (no cortex lock). Opens the system browser
/// when the auth URL is ready and returns the parsed outcome after IdP login.
pub async fn run_sso_listener(
    cortex_dir: &Path,
    client_secret: Option<&str>,
) -> Result<SsoListenerSuccess> {
    let binary = resolve_sidecar_path()?;
    let mut cmd = Command::new(&binary);
    cmd.env("GRAPHNOSIS_SSO_LISTENER", "1")
        .env("GRAPHNOSIS_CORTEX", cortex_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(secret) = client_secret {
        cmd.env("GRAPHNOSIS_SSO_CLIENT_SECRET", secret);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);

    let mut child = cmd.spawn().context("spawn SSO listener")?;
    let stderr = child.stderr.take().context("SSO listener stderr")?;
    let mut lines = BufReader::new(stderr).lines();

    let mut result_line: Option<String> = None;
    let mut browser_opened = false;

    while let Some(line) = lines.next_line().await.context("read SSO listener stderr")? {
        eprintln!("{}", line);
        if let Some(url) = line.strip_prefix("GRAPHNOSIS_SSO_AUTH_URL:") {
            if !browser_opened {
                browser_opened = true;
                open_system_url(url)?;
            }
        }
        if let Some(json) = line.strip_prefix("GRAPHNOSIS_SSO_RESULT:") {
            result_line = Some(json.to_string());
            break;
        }
    }

    let status = child.wait().await.context("wait for SSO listener")?;
    let json = result_line.ok_or_else(|| anyhow!("SSO listener did not emit result"))?;
    let outcome: SsoListenerOutcome =
        serde_json::from_str(&json).context("parse SSO listener result")?;
    if !outcome.ok {
        let message = outcome
            .message
            .or(outcome.reason)
            .unwrap_or_else(|| "SSO sign-in failed".to_string());
        bail!("{message}");
    }
    if !status.success() {
        bail!("SSO listener exited with status {}", status);
    }
    let role = outcome
        .resolved_role
        .ok_or_else(|| anyhow!("SSO result missing resolved_role"))?;
    Ok(SsoListenerSuccess {
        email: outcome.email,
        subject: outcome.subject,
        groups: outcome.groups.unwrap_or_default(),
        resolved_role: role,
    })
}

fn open_system_url(url: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(url)
            .spawn()
            .context("open auth URL in browser")?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .spawn()
            .context("open auth URL in browser")?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .context("open auth URL in browser")?;
    }
    Ok(())
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SsoDiscoverSnapshot {
    pub configured: bool,
    pub enabled: bool,
    pub provisioned: bool,
    pub idp_reachable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idp_reachability_error: Option<String>,
    pub suggested_button_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tenant_hint: Option<String>,
    pub break_glass_passphrase: bool,
    pub show_button: bool,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Pre-unlock SSO discover — IdP reachability probe via sidecar subprocess.
pub async fn run_sso_probe(cortex_dir: &Path) -> Result<SsoDiscoverSnapshot> {
    let binary = resolve_sidecar_path()?;
    let mut cmd = Command::new(&binary);
    cmd.env("GRAPHNOSIS_SSO_PROBE", "1")
        .env("GRAPHNOSIS_CORTEX", cortex_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);

    let mut child = cmd.spawn().context("spawn SSO probe")?;
    let stderr = child.stderr.take().context("SSO probe stderr")?;
    let mut lines = BufReader::new(stderr).lines();

    let mut result_line: Option<String> = None;
    while let Some(line) = lines.next_line().await.context("read SSO probe stderr")? {
        eprintln!("{}", line);
        if let Some(json) = line.strip_prefix("GRAPHNOSIS_SSO_PROBE_RESULT:") {
            result_line = Some(json.to_string());
            break;
        }
    }

    let _status = child.wait().await.context("wait for SSO probe")?;
    let json = result_line.ok_or_else(|| anyhow!("SSO probe did not emit result"))?;
    serde_json::from_str(&json).context("parse SSO probe result")
}

