// Per-cortex passphrase cache for the Touch ID unlock flow.
//
// HISTORY: we tried the `keyring` v3 crate first (silently no-op'd on
// unsigned macOS dev binaries). Then we shelled out to `security` CLI (worked
// from bash but Tauri's subprocess couldn't read its own writes because
// macOS Keychain enforces per-process audit-token rules that unsigned dev
// binaries don't satisfy reliably).
//
// CURRENT APPROACH — three paths:
//
//   Windows (always):
//     `keyring` v3 crate → Windows Credential Manager (DPAPI).
//     User-scoped; no code-signing requirement on Windows.
//
//   macOS + `--features keychain` (signed release / CI builds):
//     `keyring` v3 crate → macOS Keychain Services API.
//     Items are bound to the signed binary; no other process can read them.
//     Enable in the release pipeline: `cargo tauri build --features keychain`.
//     MIGRATION: on first load after upgrade from file-cache builds, the
//     old `.passphrase` file is read, promoted to Keychain, then deleted.
//
//   macOS without `keychain` feature (unsigned dev builds):
//     Writes the passphrase to a 0600-permission file under
//     `~/Library/Application Support/Graphnosis/touchid-cache/`.
//     Any user-level process can read it — acceptable for dev only.
//     File is OUTSIDE the cortex folder so a stolen/synced cortex still
//     requires the passphrase or 24-word recovery phrase to unlock.

use anyhow::Result;

// ── Stable account / filename identifier ─────────────────────────────────────
// Derives a stable, filesystem-safe string from the cortex path.
// Used as the Keychain account name and as the file stem — both modes
// address the same cortex via the same identifier.
//
//   "/Users/nelulazar/Graphnosis-test" → "Users_nelulazar_Graphnosis-test"
fn account_for(cortex_dir: &str) -> String {
    let mut safe = String::with_capacity(cortex_dir.len());
    for c in cortex_dir.chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '.' {
            safe.push(c);
        } else {
            safe.push('_');
        }
    }
    safe.trim_start_matches('_').to_string()
}

// ── keyring path (Windows always; macOS when `keychain` feature is on) ───────
#[cfg(any(target_os = "windows", feature = "keychain"))]
mod kc {
    use super::account_for;
    use anyhow::{Context, Result};

    const SERVICE: &str = "app.graphnosis";

    fn entry(cortex_dir: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(SERVICE, &account_for(cortex_dir))
            .context("create keyring entry")
    }

    pub fn store(cortex_dir: &str, passphrase: &str) -> Result<()> {
        entry(cortex_dir)?
            .set_password(passphrase)
            .context("write passphrase to system credential store")
    }

    pub fn load(cortex_dir: &str) -> Result<Option<String>> {
        match entry(cortex_dir)?.get_password() {
            Ok(p) => Ok(Some(p)),
            Err(keyring::Error::NoEntry) => {
                // macOS only: check for a legacy file-cache entry left by an
                // older unsigned build and migrate it to the Keychain on the spot.
                #[cfg(target_os = "macos")]
                {
                    if let Some(legacy) = super::file_cache::load(cortex_dir)? {
                        // Promote to Keychain.
                        store(cortex_dir, &legacy)?;
                        // Clean up the plaintext file.
                        let _ = super::file_cache::clear(cortex_dir);
                        return Ok(Some(legacy));
                    }
                }
                Ok(None)
            }
            Err(e) => Err(anyhow::anyhow!(e)).context("read passphrase from system credential store"),
        }
    }

    pub fn clear(cortex_dir: &str) -> Result<()> {
        match entry(cortex_dir)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(anyhow::anyhow!(e))
                .context("delete passphrase from system credential store"),
        }
    }
}

// ── file-cache path (macOS dev builds without `keychain` feature) ─────────────
// Also compiled on macOS+keychain for the migration helper above.
// `store` is only called in the non-keychain path, so suppress the warning
// when the module is included solely for migration reads.
#[cfg(target_os = "macos")]
#[allow(dead_code)]
mod file_cache {
    use super::account_for;
    use anyhow::{anyhow, Context, Result};
    use std::path::PathBuf;
    use std::os::unix::fs::PermissionsExt;

    fn cache_dir() -> Result<PathBuf> {
        let base = dirs::data_local_dir()
            .ok_or_else(|| anyhow!("could not resolve user data directory"))?;
        Ok(base.join("Graphnosis").join("touchid-cache"))
    }

    fn cache_file(cortex_dir: &str) -> Result<PathBuf> {
        Ok(cache_dir()?.join(format!("{}.passphrase", account_for(cortex_dir))))
    }

    pub fn store(cortex_dir: &str, passphrase: &str) -> Result<()> {
        let path = cache_file(cortex_dir)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create dir {}", parent.display()))?;
        }
        std::fs::write(&path, passphrase.as_bytes())
            .with_context(|| format!("write passphrase to {}", path.display()))?;
        let mut perms = std::fs::metadata(&path)?.permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(&path, perms)
            .with_context(|| format!("chmod 0600 {}", path.display()))?;
        Ok(())
    }

    pub fn load(cortex_dir: &str) -> Result<Option<String>> {
        let path = cache_file(cortex_dir)?;
        match std::fs::read_to_string(&path) {
            Ok(s) => Ok(Some(s)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(anyhow!(e))
                .with_context(|| format!("read {}", path.display())),
        }
    }

    pub fn clear(cortex_dir: &str) -> Result<()> {
        let path = cache_file(cortex_dir)?;
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(anyhow!(e))
                .with_context(|| format!("remove {}", path.display())),
        }
    }
}

// On macOS without the `keychain` feature, delegate to the file cache.
#[cfg(all(not(target_os = "windows"), not(feature = "keychain")))]
mod kc {
    use super::file_cache;
    use anyhow::Result;

    pub fn store(cortex_dir: &str, passphrase: &str) -> Result<()> {
        file_cache::store(cortex_dir, passphrase)
    }
    pub fn load(cortex_dir: &str) -> Result<Option<String>> {
        file_cache::load(cortex_dir)
    }
    pub fn clear(cortex_dir: &str) -> Result<()> {
        file_cache::clear(cortex_dir)
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

pub fn store_passphrase(cortex_dir: &str, passphrase: &str) -> Result<()> {
    kc::store(cortex_dir, passphrase)
}

pub fn load_passphrase(cortex_dir: &str) -> Result<Option<String>> {
    kc::load(cortex_dir)
}

#[allow(dead_code)]
pub fn clear_passphrase(cortex_dir: &str) -> Result<()> {
    kc::clear(cortex_dir)
}
