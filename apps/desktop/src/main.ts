import { invoke } from '@tauri-apps/api/core';

// UI is intentionally a thin shell during scaffolding. All real work lives in the
// Tauri Rust side (autostart, hotkeys, keychain, sidecar lifecycle) and the Node
// sidecar (Graphnosis, MCP, ingest, correction).

const pick = document.getElementById('btn-pick');
pick?.addEventListener('click', async () => {
  try {
    const folder = await invoke<string | null>('pick_vault_folder');
    if (folder) {
      console.log('Selected vault folder:', folder);
    }
  } catch (e) {
    console.error(e);
  }
});
