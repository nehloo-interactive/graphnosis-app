import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

// Inject the desktop package.json version at build time so the frontend
// can show it in the status bar without an extra Tauri IPC roundtrip.
const pkgVersion = JSON.parse(readFileSync('./package.json', 'utf8')).version;

export default defineConfig({
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    // Disable HMR entirely. File changes are compiled silently; the Tauri
    // WebView never auto-reloads. Refresh manually when you want to see UI
    // changes. This prevents event-socket disconnects and lost ingest-progress
    // state during long ingests.
    hmr: false,
    watch: {
      // Exclude Claude Code's agent worktrees — they live inside the project
      // root but are separate git worktrees.
      ignored: ['**/.claude/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  define: {
    // Surfaces in main.ts as __APP_VERSION__ — used to render the version
    // pill in the status bar (left of Vitality). Resolved at build time.
    __APP_VERSION__: JSON.stringify(pkgVersion),
  },
  build: {
    target: 'safari15',
    minify: 'esbuild',
    sourcemap: true,
    rollupOptions: {
      // Multi-page build: index.html is the main app shell; about.html is
      // the standalone About panel opened by the Tauri command
      // `open_about_window`. Vite needs both listed explicitly or it
      // silently drops the second page from the production bundle.
      input: {
        main: 'index.html',
        about: 'about.html',
      },
    },
  },
});
