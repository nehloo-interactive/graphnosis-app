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
//   "/Users/alex/Graphnosis-test" → "Users_alex_Graphnosis-test"
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

// ── Remote-server token identifier ───────────────────────────────────────────
// The remote "Browser access" token is keyed by the server ORIGIN, not a
// filesystem path — so it must NOT go through `normalize_cortex_dir` (which
// canonicalizes as a path). Normalization must be stable across store + load +
// existence-probe AND aligned with the base `unlock_cortex` resolves
// (`trim().trim_end_matches('/')`, lib.rs). We additionally lowercase the whole
// origin so `https://Host.TS.net` and `https://host.ts.net` share one entry —
// safe because a bare `scheme://host:port` has no case-sensitive path segment.
pub fn normalize_remote_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_ascii_lowercase()
}

// Keychain account / file stem for a server's stored token. `account_for`
// makes it filesystem- and keychain-safe; the distinct SERVICE namespace
// (below) keeps it clear of the passphrase (`app.graphnosis`) and SSO
// (`app.graphnosis.sso`) entries.
#[allow(dead_code)] // used by whichever token_kc backend this build compiles
fn token_account(url: &str) -> String {
    account_for(&normalize_remote_url(url))
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
    let passphrase = passphrase.trim();
    if !is_usable_passphrase(passphrase) {
        return Err(anyhow::anyhow!("refusing to store empty passphrase for Touch ID"));
    }
    kc::store(&normalize_cortex_dir(cortex_dir), passphrase)
}

pub fn load_passphrase(cortex_dir: &str) -> Result<Option<String>> {
    let normalized = normalize_cortex_dir(cortex_dir);
    if let Some(p) = kc::load(&normalized)? {
        if is_usable_passphrase(&p) {
            return Ok(Some(p.trim().to_string()));
        }
        // Corrupt / empty entry at the current key — clear and fall through to
        // legacy migration (common after a cortex folder move left a 0-byte file).
        let _ = kc::clear(&normalized);
    }
    // Pre-normalization installs and moved cortex folders may be keyed under
    // a different literal path (trailing slash, old parent directory, …).
    for legacy in legacy_touchid_candidates(&normalized, cortex_dir) {
        if let Some(p) = kc::load(&legacy)? {
            let trimmed = p.trim().to_string();
            if !is_usable_passphrase(&trimmed) {
                continue;
            }
            // Promote to the normalized key so future lookups are stable.
            let _ = kc::store(&normalized, &trimmed);
            let _ = kc::clear(&legacy);
            return Ok(Some(trimmed));
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

pub fn clear_passphrase(cortex_dir: &str) -> Result<()> {
    kc::clear(&normalize_cortex_dir(cortex_dir))
}

// ── Remote-server access-token store (Touch ID for a remote cortex) ──────────
// Stores the durable "Browser access" token so Touch ID can re-submit it to the
// remote server's /api/unlock. Keyed by the normalized server origin. Distinct
// SERVICE namespace ("app.graphnosis.remote-token") keeps it apart from the
// passphrase ("app.graphnosis") and SSO ("app.graphnosis.sso") entries.
//
// THREE backends, mirroring the passphrase store, but the macOS signed path is
// HARDENED: the token is a network bearer credential (usable from anywhere
// until revoked), stricter than a local passphrase, so on signed macOS builds
// it is sealed under a Secure-Enclave biometry-current-set access control — the
// OS refuses to release the data without a live, currently-enrolled fingerprint.

// macOS signed release (`--features keychain`): data-protection keychain item
// under kSecAccessControlBiometryCurrentSet. Reading the DATA triggers the OS
// Touch ID prompt (hardware-enforced); an attributes-only existence probe does
// NOT prompt, so the lock screen can decide whether to show the button silently.
#[cfg(all(target_os = "macos", feature = "keychain"))]
mod token_kc {
    use super::token_account;
    use anyhow::{anyhow, Result};
    use core_foundation::base::{CFType, CFTypeRef, TCFType};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::data::{CFData, CFDataRef};
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::{CFString, CFStringRef};
    use security_framework::access_control::{ProtectionMode, SecAccessControl};
    use security_framework_sys::access_control::kSecAccessControlBiometryCurrentSet;
    use security_framework_sys::base::errSecItemNotFound;
    use security_framework_sys::item::{
        kSecAttrAccessControl, kSecAttrAccount, kSecAttrService, kSecClass,
        kSecClassGenericPassword, kSecReturnAttributes, kSecReturnData,
        kSecUseDataProtectionKeychain, kSecValueData,
    };
    use security_framework_sys::keychain_item::{SecItemAdd, SecItemCopyMatching, SecItemDelete};
    use std::ptr;

    const SERVICE: &str = "app.graphnosis.remote-token";
    // Not re-exported by security-framework-sys; hard-code the documented values.
    const ERR_USER_CANCELED: i32 = -128; // errSecUserCanceled
    const ERR_AUTH_FAILED: i32 = -25293; // errSecAuthFailed (biometry lockout)
    const ERR_INTERACTION_NOT_ALLOWED: i32 = -25308; // errSecInteractionNotAllowed

    /// Wrap a Security.framework static CFStringRef constant as a dictionary key.
    /// SAFETY: the constants are valid immortal CFStrings; get-rule wrap retains.
    unsafe fn key(r: CFStringRef) -> CFType {
        CFString::wrap_under_get_rule(r).as_CFType()
    }

    fn base_query(account: &str) -> [(CFType, CFType); 4] {
        let service = CFString::new(SERVICE);
        let account_s = CFString::new(account);
        unsafe {
            [
                (key(kSecClass), key(kSecClassGenericPassword)),
                (key(kSecAttrService), service.as_CFType()),
                (key(kSecAttrAccount), account_s.as_CFType()),
                (key(kSecUseDataProtectionKeychain), CFBoolean::true_value().as_CFType()),
            ]
        }
    }

    pub fn store(url: &str, token: &str) -> Result<()> {
        // SecItemAdd returns errSecDuplicateItem if the entry exists — delete first.
        let _ = clear(url);
        let account = token_account(url);
        let ac = SecAccessControl::create_with_protection(
            Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly),
            kSecAccessControlBiometryCurrentSet,
        )
        .map_err(|e| anyhow!("create Secure-Enclave access control: {e}"))?;
        let data = CFData::from_buffer(token.as_bytes());
        let mut pairs: Vec<(CFType, CFType)> = base_query(&account).into();
        unsafe {
            pairs.push((key(kSecValueData), data.as_CFType()));
            pairs.push((key(kSecAttrAccessControl), ac.as_CFType()));
        }
        let dict = CFDictionary::from_CFType_pairs(&pairs);
        let status = unsafe { SecItemAdd(dict.as_concrete_TypeRef(), ptr::null_mut()) };
        // -34018 = errSecMissingEntitlement: the data-protection keychain needs a
        // keychain-access-groups (or application-identifier) entitlement. A signed
        // build missing it can't seal the token — fail loudly rather than silently
        // downgrade, so the caller reports it instead of pretending Touch ID works.
        if status == -34018 {
            return Err(anyhow!(
                "Touch ID keychain storage is unavailable: the app build is missing the \
                 keychain-access-groups entitlement (errSecMissingEntitlement)."
            ));
        }
        if status != 0 {
            return Err(anyhow!("SecItemAdd for remote token failed (OSStatus {status})"));
        }
        Ok(())
    }

    /// Read the token — TRIGGERS the OS Touch ID prompt (data is Enclave-sealed).
    pub fn load(url: &str) -> Result<Option<String>> {
        let account = token_account(url);
        let mut pairs: Vec<(CFType, CFType)> = base_query(&account).into();
        unsafe { pairs.push((key(kSecReturnData), CFBoolean::true_value().as_CFType())); }
        let query = CFDictionary::from_CFType_pairs(&pairs);
        let mut result: CFTypeRef = ptr::null();
        let status = unsafe { SecItemCopyMatching(query.as_concrete_TypeRef(), &mut result) };
        match status {
            0 => {
                if result.is_null() {
                    return Ok(None);
                }
                let data = unsafe { CFData::wrap_under_create_rule(result as CFDataRef) };
                Ok(Some(String::from_utf8_lossy(data.bytes()).into_owned()))
            }
            e if e == errSecItemNotFound => Ok(None),
            ERR_USER_CANCELED => Err(anyhow!("biometric authentication cancelled")),
            ERR_AUTH_FAILED => Err(anyhow!(
                "Touch ID authentication failed or is temporarily locked — enter your access token instead."
            )),
            ERR_INTERACTION_NOT_ALLOWED => Err(anyhow!(
                "Touch ID isn't available in this context — enter your access token instead."
            )),
            e => Err(anyhow!("keychain read for remote token failed (OSStatus {e})")),
        }
    }

    /// Existence probe — attributes only, so it never triggers the biometric.
    pub fn has(url: &str) -> Result<bool> {
        let account = token_account(url);
        let mut pairs: Vec<(CFType, CFType)> = base_query(&account).into();
        unsafe { pairs.push((key(kSecReturnAttributes), CFBoolean::true_value().as_CFType())); }
        let query = CFDictionary::from_CFType_pairs(&pairs);
        let mut result: CFTypeRef = ptr::null();
        let status = unsafe { SecItemCopyMatching(query.as_concrete_TypeRef(), &mut result) };
        if !result.is_null() {
            // Release the returned attributes dictionary (create rule).
            let _ = unsafe { CFType::wrap_under_create_rule(result) };
        }
        match status {
            0 => Ok(true),
            e if e == errSecItemNotFound => Ok(false),
            e => Err(anyhow!("keychain existence probe for remote token failed (OSStatus {e})")),
        }
    }

    pub fn clear(url: &str) -> Result<()> {
        let account = token_account(url);
        let pairs: Vec<(CFType, CFType)> = base_query(&account).into();
        let query = CFDictionary::from_CFType_pairs(&pairs);
        let status = unsafe { SecItemDelete(query.as_concrete_TypeRef()) };
        match status {
            0 => Ok(()),
            e if e == errSecItemNotFound => Ok(()),
            e => Err(anyhow!("SecItemDelete for remote token failed (OSStatus {e})")),
        }
    }
}

// Windows: Credential Manager via keyring (soft — Windows Hello is a separate
// gate applied at unlock time by the winhello sidecar, mirroring the passphrase).
#[cfg(target_os = "windows")]
mod token_kc {
    use super::token_account;
    use anyhow::{Context, Result};

    const SERVICE: &str = "app.graphnosis.remote-token";

    fn entry(url: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(SERVICE, &token_account(url)).context("create token keyring entry")
    }
    pub fn store(url: &str, token: &str) -> Result<()> {
        entry(url)?.set_password(token).context("write remote token to credential store")
    }
    pub fn load(url: &str) -> Result<Option<String>> {
        match entry(url)?.get_password() {
            Ok(t) => Ok(Some(t)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(anyhow::anyhow!(e)).context("read remote token"),
        }
    }
    pub fn has(url: &str) -> Result<bool> {
        Ok(load(url)?.is_some())
    }
    pub fn clear(url: &str) -> Result<()> {
        match entry(url)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(anyhow::anyhow!(e)).context("delete remote token"),
        }
    }
}

// macOS unsigned dev + Linux: 0600 plaintext file (SOFT — dev only). The Swift
// biometric sidecar boolean gates the read at unlock time; the file itself is
// not Enclave-sealed. Acceptable for dev; NEVER shipped (release builds set the
// `keychain` feature and take the hardened path above).
#[cfg(all(not(target_os = "windows"), not(all(target_os = "macos", feature = "keychain"))))]
mod token_kc {
    use super::{account_for, normalize_remote_url};
    use anyhow::{anyhow, Context, Result};
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    fn cache_file(url: &str) -> Result<PathBuf> {
        let base = dirs::data_local_dir()
            .ok_or_else(|| anyhow!("could not resolve user data directory"))?;
        let dir = base.join("Graphnosis").join("touchid-cache");
        Ok(dir.join(format!("token-{}.token", account_for(&normalize_remote_url(url)))))
    }

    pub fn store(url: &str, token: &str) -> Result<()> {
        let path = cache_file(url)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        }
        std::fs::write(&path, token.as_bytes()).with_context(|| format!("write {}", path.display()))?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .with_context(|| format!("chmod 0600 {}", path.display()))?;
        Ok(())
    }
    pub fn load(url: &str) -> Result<Option<String>> {
        match std::fs::read_to_string(cache_file(url)?) {
            Ok(s) if !s.trim().is_empty() => Ok(Some(s)),
            Ok(_) => Ok(None),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(anyhow!(e)).context("read remote token file"),
        }
    }
    pub fn has(url: &str) -> Result<bool> {
        Ok(cache_file(url)?.exists())
    }
    pub fn clear(url: &str) -> Result<()> {
        match std::fs::remove_file(cache_file(url)?) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(anyhow!(e)).context("remove remote token file"),
        }
    }
}

/// Store a remote server's access token so Touch ID can re-submit it. Opt-in:
/// callers invoke this only after the user accepts the enrollment prompt.
pub fn store_remote_token(server_url: &str, token: &str) -> Result<()> {
    let token = token.trim();
    if token.is_empty() {
        return Err(anyhow::anyhow!("refusing to store an empty remote token"));
    }
    token_kc::store(server_url, token)
}

/// Retrieve a stored token. On the hardened macOS path this TRIGGERS the OS
/// biometric prompt; on soft paths the caller gates with `biometric::prompt`.
pub fn load_remote_token(server_url: &str) -> Result<Option<String>> {
    token_kc::load(server_url)
}

/// Whether a token is stored for this server — never triggers the biometric,
/// so it is safe to call on every lock-screen render / URL change.
pub fn has_remote_token(server_url: &str) -> Result<bool> {
    token_kc::has(server_url)
}

pub fn clear_remote_token(server_url: &str) -> Result<()> {
    token_kc::clear(server_url)
}
