// Per-cortex passphrase cache for the Touch ID unlock flow.
//
// HISTORY: we tried the `keyring` v3 crate first (silently no-op'd on
// unsigned dev binaries). Then we shelled out to `security` CLI (worked
// from bash but Tauri's subprocess couldn't read its own writes because
// macOS keychain access enforces per-process audit-token rules that
// unsigned dev binaries don't satisfy reliably).
//
// CURRENT APPROACH: write the passphrase to a 0600-permission file under
// `~/Library/Application Support/Graphnosis/touchid-cache/`. The file
// name is a stable hash of the cortex path so we get a per-cortex entry
// without dealing with path encoding.
//
// SECURITY TRADE-OFFS:
//   - Equivalent to the macOS Keychain `-A` flag: any local process
//     running as this user can read the file.
//   - File is OUTSIDE the cortex folder, so it doesn't follow iCloud /
//     Dropbox sync. Stolen Cortex folder still requires the passphrase
//     or 24-word recovery phrase to open.
//   - When we ship code-signed release builds, switch back to keychain
//     with `-T <signed-binary-path>` so only Graphnosis itself can read
//     its own entries.

use anyhow::{anyhow, Context, Result};
use std::path::PathBuf;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

fn cache_dir() -> Result<PathBuf> {
    // ~/Library/Application Support/Graphnosis/touchid-cache on macOS.
    // `dirs::data_local_dir()` returns Library/Application Support on macOS,
    // %LOCALAPPDATA% on Windows, ~/.local/share on Linux. Works across platforms.
    let base = dirs::data_local_dir()
        .ok_or_else(|| anyhow!("could not resolve user data directory"))?;
    Ok(base.join("Graphnosis").join("touchid-cache"))
}

fn cache_file(cortex_dir: &str) -> Result<PathBuf> {
    // Derive a stable, filename-safe identifier from the cortex path.
    //
    // First implementation used `std::collections::hash_map::DefaultHasher`,
    // which is RANDOMLY SEEDED per process — different filenames per launch,
    // so store-then-load failed silently. (Rust std docs explicitly warn:
    // "this hasher is not guaranteed to be the same as all other DefaultHashers
    // ... and its hashes should not be relied upon over releases.")
    //
    // Switched to a deterministic sanitization of the path itself:
    //   "/Users/nelulazar/Graphnosis-test" → "Users_nelulazar_Graphnosis-test"
    // Replaces every non-alphanumeric / non-`-` / non-`.` char with `_` so
    // the filename is filesystem-safe across every Mac filesystem.
    let mut safe = String::with_capacity(cortex_dir.len());
    for c in cortex_dir.chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '.' {
            safe.push(c);
        } else {
            safe.push('_');
        }
    }
    // Trim leading underscores so we don't get hidden-file-like names
    // ("_Users_..." → "Users_..."). Cosmetic; functionally same either way.
    let trimmed = safe.trim_start_matches('_');
    Ok(cache_dir()?.join(format!("{}.passphrase", trimmed)))
}

pub fn store_passphrase(cortex_dir: &str, passphrase: &str) -> Result<()> {
    let path = cache_file(cortex_dir)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create dir {}", parent.display()))?;
    }
    std::fs::write(&path, passphrase.as_bytes())
        .with_context(|| format!("write passphrase to {}", path.display()))?;
    // Owner-only read/write. Defense in depth — restricts other users on
    // the same machine, doesn't help against same-user attackers.
    #[cfg(unix)]
    {
        let mut perms = std::fs::metadata(&path)?.permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(&path, perms)
            .with_context(|| format!("chmod 0600 {}", path.display()))?;
    }
    Ok(())
}

pub fn load_passphrase(cortex_dir: &str) -> Result<Option<String>> {
    let path = cache_file(cortex_dir)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(anyhow!(e)).with_context(|| format!("read {}", path.display())),
    }
}

#[allow(dead_code)]
pub fn clear_passphrase(cortex_dir: &str) -> Result<()> {
    let path = cache_file(cortex_dir)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(anyhow!(e)).with_context(|| format!("remove {}", path.display())),
    }
}
