//! Thin Rust wrapper around the Swift `graphnosis-biometric` sidecar binary.
//!
//! The Swift source lives at `swift/graphnosis-biometric.swift` and is
//! compiled by `build.rs` into `binaries/graphnosis-biometric-<triple>`.
//! Tauri's `externalBin` config in `tauri.conf.json` bundles the binary on
//! release builds; in dev, `tauri_plugin_shell` resolves the same path
//! automatically via the triple suffix.
//!
//! Two functions:
//!   - `is_available()`  → spawns the sidecar with `--check`, returns true
//!                          if biometric hardware is configured + enrolled.
//!   - `prompt(reason)`  → spawns the sidecar with `--prompt <reason>`,
//!                          returns true on user-confirmed biometric.
//!
//! Both block on the sidecar process. Caller is async-aware (spawn_blocking).

use anyhow::{anyhow, Result};
use std::sync::OnceLock;
use tauri::AppHandle;
use tauri_plugin_shell::{process::CommandEvent, ShellExt};
use tokio::sync::Mutex;

// Tauri-plugin-shell's `sidecar(name)` resolves to
// `<binaries-dir>/<name>-<triple>`. The `binaries/` prefix is implicit —
// passing it explicitly produces "<binaries-dir>/binaries/<name>-<triple>"
// which doesn't exist, surfacing as "No such file or directory" at spawn
// time. Base name only.
const SIDECAR_NAME: &str = "graphnosis-biometric";

fn sidecar_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Spawn the sidecar with the given args, collect stdout + exit code.
///
/// Returns Ok((exit_code, stdout)). Errors are reserved for sidecar-spawn
/// failures (e.g. binary missing). A non-zero exit code (1 = unavailable,
/// 2 = failed) is NOT an error — it's a normal authentication outcome.
async fn run_sidecar(app: &AppHandle, args: &[&str]) -> Result<(i32, String)> {
    // Serialize all biometric sidecar spawns. Concurrent --check probes (boot
    // refresh + lock-screen render) racing a --prompt unlock caused flaky
    // first-attempt Touch ID failures on macOS LocalAuthentication.
    let _guard = sidecar_lock().lock().await;

    let sidecar = app
        .shell()
        .sidecar(SIDECAR_NAME)
        .map_err(|e| anyhow!("biometric sidecar not available: {e}"))?
        .args(args);

    let (mut rx, _child) = sidecar
        .spawn()
        .map_err(|e| anyhow!("failed to spawn biometric sidecar: {e}"))?;

    let mut stdout_buf = String::new();
    let mut exit_code: Option<i32> = None;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                stdout_buf.push_str(&String::from_utf8_lossy(&bytes));
            }
            CommandEvent::Stderr(_) => {
                // Swift sidecar writes to stderr only on argv errors;
                // safe to ignore for normal --check / --prompt flows.
            }
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code;
                break;
            }
            CommandEvent::Error(e) => {
                return Err(anyhow!("biometric sidecar error: {e}"));
            }
            _ => {}
        }
    }

    let code = exit_code.unwrap_or(-1);
    Ok((code, stdout_buf.trim().to_string()))
}

/// Returns true if biometric is set up on this Mac (Touch ID hardware
/// present + at least one fingerprint enrolled), false otherwise.
///
/// Cheap enough to call on lock-screen render. Errors degrade to false —
/// a missing sidecar binary or a swiftc-less dev machine means "no
/// biometric available" rather than blowing up the app.
pub async fn is_available(app: &AppHandle) -> bool {
    match run_sidecar(app, &["--check"]).await {
        Ok((0, _)) => true,
        Ok(_) => false,
        Err(e) => {
            // Only spawn failures get logged — they indicate a missing or
            // broken sidecar binary, which the user can't recover from
            // without running a build. Routine "biometric not available"
            // (locked out, not enrolled) just hides the UI button silently.
            eprintln!("[biometric] could not spawn sidecar: {e}");
            false
        }
    }
}

/// Show the macOS biometric prompt with the given reason string. Returns
/// Ok(true) if the user authenticated, Ok(false) if they cancelled or
/// failed, or Err if the sidecar couldn't even be spawned.
pub async fn prompt(app: &AppHandle, reason: &str) -> Result<bool> {
    let (code, stdout) = run_sidecar(app, &["--prompt", reason]).await?;
    match code {
        0 => Ok(true),
        1 => {
            // Biometric not available — surface as a clean error so the
            // UI can fall back to passphrase entry without a generic toast.
            Err(anyhow!("Touch ID unavailable: {}", stdout))
        }
        2 => Ok(false), // user cancelled or biometric mismatch
        other => Err(anyhow!(
            "biometric sidecar returned unexpected exit code {} ({})",
            other,
            stdout
        )),
    }
}
