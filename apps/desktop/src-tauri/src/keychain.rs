use anyhow::{Context, Result};
use keyring::Entry;

const SERVICE: &str = "app.graphnosis";

fn account_for(vault_dir: &str) -> String {
    format!("vault:{}", vault_dir)
}

pub fn store_passphrase(vault_dir: &str, passphrase: &str) -> Result<()> {
    Entry::new(SERVICE, &account_for(vault_dir))
        .context("create keyring entry")?
        .set_password(passphrase)
        .context("write passphrase to OS keychain")
}

pub fn load_passphrase(vault_dir: &str) -> Result<Option<String>> {
    match Entry::new(SERVICE, &account_for(vault_dir))?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn clear_passphrase(vault_dir: &str) -> Result<()> {
    match Entry::new(SERVICE, &account_for(vault_dir))?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}
