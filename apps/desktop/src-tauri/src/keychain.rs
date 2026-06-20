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
//
// Paths are normalized before hashing so minor UI differences (trailing
// slash, surrounding whitespace, symlink vs real path) don't miss the
// keychain entry that was written on a prior passphrase unlock.
pub fn normalize_cortex_dir(cortex_dir: &str) -> String {
    let trimmed = cortex_dir.trim();
    let path = std::path::Path::new(trimmed);
    if path.is_dir() {
        if let Ok(canon) = path.canonicalize() {
            return canon.to_string_lossy().into_owned();
        }
    }
    let mut s = trimmed.to_string();
    while s.len() > 1 && (s.ends_with('/') || s.ends_with('\\')) {
        s.pop();
    }
    s
}

fn account_for(path: &str) -> String {
    let mut safe = String::with_capacity(path.len());
    for c in path.chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '.' {
            safe.push(c);
        } else {
            safe.push('_');
        }
    }
    safe.trim_start_matches('_').to_string()
}

fn is_usable_passphrase(passphrase: &str) -> bool {
    !passphrase.trim().is_empty()
}

/// Paths that may still hold a Touch ID cache entry from before
/// `normalize_cortex_dir` or from moving the cortex folder (e.g.
/// `~/Graphnosis-UI-Test` → `~/Documents/Graphnosis/Graphnosis-UI-Test`).
fn legacy_touchid_candidates(normalized: &str, raw: &str) -> Vec<String> {
    let trimmed = raw.trim();
    let mut out = vec![trimmed.to_string()];
    if !trimmed.ends_with('/') && !trimmed.ends_with('\\') {
        out.push(format!("{}/", trimmed));
    }
    let path = std::path::Path::new(normalized);
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        if let Some(home) = dirs::home_dir() {
            out.push(home.join(name).to_string_lossy().into_owned());
        }
    }
    let mut deduped = Vec::new();
    for candidate in out {
        if candidate == normalized || deduped.iter().any(|c| c == &candidate) {
            continue;
        }
        deduped.push(candidate);
    }
    deduped
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

// ── file-cache path (any non-Windows build without the `keychain` feature) ────
// This is generic unix code (0600-permission file via PermissionsExt), so it
// compiles on macOS AND Linux — both reach it through the fallback `kc` module
// below. It's also compiled on macOS+keychain for the migration helper above.
// Gated to non-Windows because Windows always uses the keyring path and never
// references this module; gating it to `macos` only is what previously broke
// the Linux build (E0432: the Linux fallback `kc` imports `super::file_cache`).
// `store` is only called in the non-keychain path, so suppress the dead-code
// warning when the module is included solely for migration reads.
#[cfg(not(target_os = "windows"))]
#[allow(dead_code)]
mod file_cache {
    use super::{account_for, is_usable_passphrase};
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
            Ok(s) if is_usable_passphrase(&s) => Ok(Some(s)),
            Ok(_) => {
                // Zero-byte or whitespace-only files block legacy migration;
                // treat as missing and remove the corrupt entry.
                let _ = std::fs::remove_file(&path);
                Ok(None)
            }
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

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct SsoKeychainSecrets {
    pub federated_unlock_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
}

#[cfg(any(target_os = "windows", feature = "keychain"))]
mod sso_kc {
    use super::{account_for, normalize_cortex_dir, SsoKeychainSecrets};
    use anyhow::{Context, Result};

    const SERVICE: &str = "app.graphnosis.sso";

    fn sso_account(cortex_dir: &str) -> String {
        format!("sso:{}", account_for(&normalize_cortex_dir(cortex_dir)))
    }

    fn entry(cortex_dir: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(SERVICE, &sso_account(cortex_dir))
            .context("create SSO keyring entry")
    }

    pub fn store(cortex_dir: &str, secrets: &SsoKeychainSecrets) -> Result<()> {
        let json = serde_json::to_string(secrets).context("serialize SSO secrets")?;
        entry(cortex_dir)?.set_password(&json).context("write SSO secrets")
    }

    pub fn load(cortex_dir: &str) -> Result<Option<SsoKeychainSecrets>> {
        match entry(cortex_dir)?.get_password() {
            Ok(json) => Ok(Some(serde_json::from_str(&json).context("parse SSO secrets")?)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }
}

#[cfg(all(not(target_os = "windows"), not(feature = "keychain")))]
mod sso_kc {
    use super::{account_for, normalize_cortex_dir, SsoKeychainSecrets};
    use anyhow::{Context, Result};
    use std::path::PathBuf;

    fn cache_file(cortex_dir: &str) -> Result<PathBuf> {
        let base = dirs::data_local_dir()
            .or_else(dirs::home_dir)
            .context("resolve app support dir")?;
        let dir = base.join("Graphnosis").join("touchid-cache");
        std::fs::create_dir_all(&dir).context("create SSO cache dir")?;
        Ok(dir.join(format!("sso-{}.json", account_for(&normalize_cortex_dir(cortex_dir)))))
    }

    pub fn store(cortex_dir: &str, secrets: &SsoKeychainSecrets) -> Result<()> {
        let path = cache_file(cortex_dir)?;
        let json = serde_json::to_string(secrets).context("serialize SSO secrets")?;
        std::fs::write(&path, json).with_context(|| format!("write {}", path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    }

    pub fn load(cortex_dir: &str) -> Result<Option<SsoKeychainSecrets>> {
        let path = cache_file(cortex_dir)?;
        match std::fs::read_to_string(&path) {
            Ok(json) => Ok(Some(serde_json::from_str(&json).context("parse SSO secrets")?)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }
}

pub fn store_sso_secrets(cortex_dir: &str, secrets: &SsoKeychainSecrets) -> Result<()> {
    if secrets.federated_unlock_key.trim().is_empty() {
        return Err(anyhow::anyhow!("refusing to store empty federated unlock key"));
    }
    sso_kc::store(&normalize_cortex_dir(cortex_dir), secrets)
}

pub fn load_sso_secrets(cortex_dir: &str) -> Result<Option<SsoKeychainSecrets>> {
    sso_kc::load(&normalize_cortex_dir(cortex_dir))
}

pub fn store_passphrase(cortex_dir: &str, passphrase: &str) -> Result<()> {
    if !is_usable_passphrase(passphrase) {
        return Err(anyhow::anyhow!("refusing to store empty passphrase for Touch ID"));
    }
    kc::store(&normalize_cortex_dir(cortex_dir), passphrase)
}

pub fn load_passphrase(cortex_dir: &str) -> Result<Option<String>> {
    let normalized = normalize_cortex_dir(cortex_dir);
    if let Some(p) = kc::load(&normalized)? {
        if is_usable_passphrase(&p) {
            return Ok(Some(p));
        }
        // Corrupt / empty entry at the current key — clear and fall through to
        // legacy migration (common after a cortex folder move left a 0-byte file).
        let _ = kc::clear(&normalized);
    }
    // Pre-normalization installs and moved cortex folders may be keyed under
    // a different literal path (trailing slash, old parent directory, …).
    for legacy in legacy_touchid_candidates(&normalized, cortex_dir) {
        if let Some(p) = kc::load(&legacy)? {
            // Promote to the normalized key so future lookups are stable.
            let _ = kc::store(&normalized, &p);
            let _ = kc::clear(&legacy);
            return Ok(Some(p));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_candidates_include_home_basename_for_nested_path() {
        let Some(home) = dirs::home_dir() else { return; };
        let normalized = home
            .join("Documents/Graphnosis/MyCortex")
            .to_string_lossy()
            .into_owned();
        let raw = normalized.clone();
        let candidates = legacy_touchid_candidates(&normalized, &raw);
        let expected = home.join("MyCortex").to_string_lossy().into_owned();
        assert!(candidates.contains(&expected));
    }

    #[test]
    fn legacy_candidates_skip_normalized_duplicate() {
        let normalized = "/Users/alice/MyCortex";
        let raw = "/Users/alice/MyCortex";
        let candidates = legacy_touchid_candidates(normalized, raw);
        assert!(!candidates.iter().any(|c| c == normalized));
    }
}

#[allow(dead_code)]
pub fn clear_passphrase(cortex_dir: &str) -> Result<()> {
    kc::clear(&normalize_cortex_dir(cortex_dir))
}
