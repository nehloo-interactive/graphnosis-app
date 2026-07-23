// Copy the compiled web UI (dist/) into src-tauri/dist so the bundler's
// `"dist"` resource entry (tauri.conf.json) ships it inside the .app at
// Contents/Resources/dist — where sidecar.rs's resolve_http_ui_static()
// looks for it. Without this copy the resource glob matches nothing and
// every packaged build serves the browser-access placeholder page instead
// of the real UI. Runs as part of beforeBuildCommand; cwd = apps/desktop.
// Cross-platform on purpose: release CI builds macOS, Windows, and Linux.
import { cpSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(appDir, 'dist');
const dest = resolve(appDir, 'src-tauri', 'dist');

if (!existsSync(resolve(src, 'index.html'))) {
  console.error(`[copy-webui-resource] ${src}/index.html not found — run the web build first.`);
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`[copy-webui-resource] ${src} → ${dest}`);
