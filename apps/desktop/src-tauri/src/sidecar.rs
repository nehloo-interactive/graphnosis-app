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

use std::env;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use tokio::process::{Child, Command};
use tokio::time::sleep;

pub struct SidecarHandle {
    child: Child,
    pub socket_path: PathBuf,
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
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let child = cmd
        .spawn()
        .with_context(|| format!("spawn sidecar ({} {})", program, args.join(" ")))?;

    // Wait for the sidecar's IPC socket to appear. 30s is generous because
    // the first launch may need to load the BGE embeddings model.
    wait_for_socket(&socket_path, Duration::from_secs(30))
        .await
        .map_err(|e| {
            anyhow!(
                "sidecar did not start cleanly within 30s: {e}. \
                 Check ~/Library/Logs/Claude/mcp-server-Graphnosis.log for details, \
                 or run `pnpm --filter @graphnosis-app/desktop-sidecar start` directly to see stderr."
            )
        })?;

    Ok(SidecarHandle { child, socket_path })
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

async fn wait_for_socket(path: &Path, max: Duration) -> Result<()> {
    let start = std::time::Instant::now();
    while start.elapsed() < max {
        if path.exists() {
            return Ok(());
        }
        sleep(Duration::from_millis(150)).await;
    }
    Err(anyhow!("socket {} did not appear", path.display()))
}
