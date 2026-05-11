use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::{Child, Command};

/// Spawns the Node sidecar that owns the Graphnosis SDK + MCP server.
/// The Tauri shell never touches user memory directly — all reads/writes
/// funnel through the sidecar over a Unix-domain socket.
pub struct SidecarHandle {
    child: Child,
    pub socket_path: PathBuf,
}

impl SidecarHandle {
    pub async fn shutdown(mut self) -> Result<()> {
        self.child.kill().await.context("kill sidecar")?;
        let _ = self.child.wait().await;
        let _ = std::fs::remove_file(&self.socket_path);
        Ok(())
    }
}

pub async fn start(vault_dir: &Path, passphrase: &str) -> Result<SidecarHandle> {
    let socket_path = vault_dir.join("sidecar.sock");
    let _ = std::fs::remove_file(&socket_path);

    // In dev: run via pnpm; in a packaged build, the sidecar binary ships inside the app bundle.
    // Resolve at runtime so this works both ways.
    let (program, args) = match std::env::var("GRAPHNOSIS_SIDECAR_BIN") {
        Ok(bin) => (bin, vec![]),
        Err(_) => ("pnpm".to_string(), vec![
            "--filter".into(),
            "@graphnosis-app/desktop-sidecar".into(),
            "start".into(),
        ]),
    };

    let child = Command::new(program)
        .args(&args)
        .env("GRAPHNOSIS_VAULT", vault_dir)
        .env("GRAPHNOSIS_PASSPHRASE", passphrase)
        .env("GRAPHNOSIS_IPC_SOCKET", &socket_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("spawn sidecar")?;

    Ok(SidecarHandle { child, socket_path })
}
