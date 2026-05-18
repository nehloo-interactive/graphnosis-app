import { defineConfig } from 'vite';

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
