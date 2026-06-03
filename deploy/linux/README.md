# Graphnosis on Linux / Ubuntu (standalone server)

Run the Graphnosis sidecar headless — no Tauri desktop app. It serves the full
browser UI **and** the JSON-RPC API on one port, so you reach your cortex from
any device's browser, locally or over Tailscale. The cortex stays encrypted on
this machine's disk.

> **Touch ID / Keychain are macOS-only** and irrelevant here. Server mode
> authenticates browsers with an access token (and, on supported devices,
> WebAuthn once that ships).

---

## 1. Prerequisites

- **Node ≥ 20** (`node -v`) and **pnpm** (`npm i -g pnpm`)
- Build toolchain for native modules: `sudo apt install -y build-essential python3`
- (Recommended) **Tailscale**: `curl -fsSL https://tailscale.com/install.sh | sh`

> **Build on Linux.** Do not copy a macOS build over — the native addons
> (onnxruntime, tokenizers, better-sqlite3) are platform-specific. Build here.

---

## 2. Build

```bash
sudo mkdir -p /opt/graphnosis && sudo chown "$USER" /opt/graphnosis
cd /opt/graphnosis
git clone <repo-url> GraphnosisApp
cd GraphnosisApp
pnpm install
pnpm -r build          # builds core, sidecar, and the web UI (apps/desktop/dist)
```

Smoke-test the sidecar (no Tauri, no browser needed):

```bash
pnpm --filter @graphnosis-app/desktop-sidecar smoke
```

---

## 3. Run (manual, to verify)

```bash
GRAPHNOSIS_CORTEX=~/graphnosis-cortex \
GRAPHNOSIS_PASSPHRASE='your-passphrase' \
GRAPHNOSIS_HTTP_UI=1 \
GRAPHNOSIS_BIND=0.0.0.0 \
GRAPHNOSIS_HTTP_UI_PORT=3456 \
GRAPHNOSIS_HTTP_UI_TOKEN="$(openssl rand -hex 32)" \
GRAPHNOSIS_HTTP_UI_STATIC=/opt/graphnosis/GraphnosisApp/apps/desktop/dist \
node apps/desktop-sidecar/dist/index.js
```

Watch for `HTTP UI on http://0.0.0.0:3456`, then open `http://<this-host>:3456`
from a browser and unlock with the token.

---

## 4. Install as a systemd service (always-on)

```bash
# Dedicated user + data dir
sudo useradd -r -m -d /var/lib/graphnosis graphnosis

# Config + secrets
sudo mkdir -p /etc/graphnosis
sudo cp deploy/linux/graphnosis-server.env.example /etc/graphnosis/server.env
sudo "$EDITOR" /etc/graphnosis/server.env          # set cortex, passphrase, token
sudo chmod 600 /etc/graphnosis/server.env
sudo chown graphnosis:graphnosis /etc/graphnosis/server.env

# Make the repo + cortex readable/writable by the service user
sudo chown -R graphnosis:graphnosis /opt/graphnosis/GraphnosisApp /var/lib/graphnosis

# Unit
sudo cp deploy/linux/graphnosis-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now graphnosis-server
sudo systemctl status graphnosis-server
journalctl -u graphnosis-server -f          # logs (token prints here if not set)
```

---

## 5. Reach it from your phone over Tailscale

1. `sudo tailscale up` on this server; install Tailscale on the phone (same tailnet).
2. Find this server's Tailscale IP: `tailscale ip -4` (a `100.x.y.z`).
3. On the phone, open `http://100.x.y.z:3456` (or scan the QR from the desktop
   app's Mobile & Remote panel, which encodes the URL + token).

Tailscale encrypts the hop end-to-end — no TLS cert needed, no public ports.
The access token gates entry.

### Optional: real-cert HTTPS via Tailscale Serve

Plain `http://100.x:PORT` already rides WireGuard, but some clients refuse
plaintext to non-localhost hosts — notably **iOS** (Safari/PWA and Claude for
iOS, via App Transport Security). `tailscale serve` fronts a local port with a
valid `*.ts.net` certificate. The browser UI and the MCP bridge are on
different ports, and Serve fronts **one backend per https endpoint**, so each
needs its own mapping:

```bash
# Browser UI → https://<host>.<tailnet>.ts.net/        (port 443)
sudo tailscale serve --bg http://127.0.0.1:3456

# MCP bridge → https://<host>.<tailnet>.ts.net:8443/    (second mapping)
sudo tailscale serve --bg --https=8443 http://127.0.0.1:3457
```

Once these are running, the desktop app's Mobile & Remote panel auto-detects
both mappings: the Browser-UI QR switches to the `https://…/` URL and the MCP
QR switches to `https://…:8443/mcp`. No sidecar TLS config needed — Tailscale
terminates the cert. (MagicDNS must be enabled in the tailnet for the name to
resolve.) Disable any time with `tailscale serve --https=8443 off`.

---

## 6. Docker (alternative to systemd)

A multi-arch image (`linux/amd64` + `linux/arm64`) is defined by the repo-root
`Dockerfile` and built/pushed by the `Linux Server` GitHub Actions workflow to
`ghcr.io/<owner>/<repo>/graphnosis-server`.

Build locally (any arch):

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t graphnosis-server .
```

Run (cortex on a named volume; secrets via `-e`):

```bash
docker run -d --name graphnosis \
  -p 3456:3456 \
  -e GRAPHNOSIS_PASSPHRASE='your-passphrase' \
  -e GRAPHNOSIS_HTTP_UI_TOKEN="$(openssl rand -hex 32)" \
  -v graphnosis-cortex:/data/cortex \
  graphnosis-server
```

The image bakes `GRAPHNOSIS_HTTP_UI=1`, `GRAPHNOSIS_BIND=0.0.0.0`, port `3456`,
and the static UI path; it has a `HEALTHCHECK` on `/`. Run the container on a
Tailscale-joined host (or `tailscale` sidecar) to reach it from your phone.

## 7. Bun single-binary (optional, for distribution)

Instead of shipping Node + the repo, compile one self-contained binary **on a
Linux host**:

```bash
curl -fsSL https://bun.sh/install | bash
cd apps/desktop-sidecar
bun build src/index.ts --compile --target=bun-linux-x64 \
  --outfile /opt/graphnosis/graphnosis-sidecar
# Ship libonnxruntime.so beside it, or point LD_LIBRARY_PATH at its dir.
```

Then set the unit's `ExecStart=/opt/graphnosis/graphnosis-sidecar` and add
`Environment=LD_LIBRARY_PATH=/opt/graphnosis` (the dir holding `libonnxruntime.so`).

Target `bun-linux-arm64` for ARM servers / Raspberry Pi.

---

## Notes

- **arm64 vs x64:** build matches the host. Parallels/OrbStack on Apple Silicon
  give you arm64; use Docker `buildx --platform linux/amd64` or a GitHub Actions
  `ubuntu-latest` runner for x64 artifacts.
- **MCP for AI clients** is a separate port (`:3457`). Expose it through Tailscale
  too if you want phone AI clients to reach the cortex's MCP tools.
- **Updates:** `git pull && pnpm install && pnpm -r build && sudo systemctl restart graphnosis-server`.
