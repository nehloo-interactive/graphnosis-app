---
title: Enterprise IT FAQ
description: Security, installation, system access, tamper resistance, OT/industrial integration, and compliance mapping for IT teams evaluating Graphnosis in enterprise environments.
sidebar:
  order: 8
---

import { Aside } from '@astrojs/starlight/components';

This page answers the questions enterprise IT, infosec, and compliance teams reliably ask before approving Graphnosis. It is written to be honest — including about gaps — rather than to be a sales document.

**TL;DR:** Graphnosis is a local, encrypted, user-owned memory store with no cloud back-end. All data stays on the device or container you deploy it on. The app makes one automatic outbound connection (a GitHub version check, verifiable claims only), requires no elevated privileges, and exposes no network-accessible endpoints by default. IT policy controls are available via environment variables. There are real limitations — no FIPS-validated crypto, no persistent per-call audit log, no MDM profiles — and they are documented here.

---

## 1. Installation — Windows, macOS, and Linux

### macOS

- **Installer format**: DMG containing a signed `.app` bundle
- **Code signing**: Developer ID Application — Nehloo Interactive LLC (Team ID: `C76ZLJ5UQW`), verified by macOS Gatekeeper on every launch
- **Notarisation**: Yes; Apple's notarisation service has scanned the binary
- **Entitlements** (`entitlements.plist`): JIT compilation and unsigned executable memory (required by Webkit/V8 inside the webview). **No App Sandbox** — the Unix socket path required for MCP clients exceeds the sandbox's `sun_path` limit. A sandboxed MAS build using TCP is planned
- **Bundled binaries**: `graphnosis-sidecar` (Bun-compiled Node.js), `graphnosis-biometric` (Swift, Touch ID only), `graphnosis-mcp-relay`
- **Passphrase caching**: macOS Keychain (signed builds), bound to the signed binary via audit token. Developer/unsigned builds use a file-based cache with user-only permissions
- **Auto-start**: None — the sidecar starts only when the app is open and the cortex is unlocked

### Windows

- **Installer format**: MSI or NSIS bundle (via Tauri)
- **Code signing**: Windows Authenticode signing on the installer and `.exe`
- **Privilege level**: User-level only — no UAC elevation, no kernel driver, no system service
- **Console window**: Sidecar runs without a visible console window
- **Bundled runtime**: Bun runtime statically bundled — no system Node.js required
- **Passphrase caching**: Windows Credential Manager (DPAPI), scoped to the current OS user
- **AI client config files written on first connect**:
  - Claude Desktop (MSI): `%APPDATA%\Claude\claude_desktop_config.json`
  - Claude Desktop (MSIX): `%LOCALAPPDATA%\Packages\Claude_<hash>\LocalCache\Roaming\Claude\`
  - Cursor: `%APPDATA%\Cursor\mcp.json`

### Linux — desktop

- **Package formats**: `.deb` (Debian/Ubuntu), `.AppImage` (portable, any distro with glibc ≥ 2.35)
- **Build baseline**: Ubuntu 22.04 for widest glibc compatibility
- **Required system libraries**: `libwebkit2gtk-4.1`, `libgomp1` (OpenMP, needed by the ONNX embedding runtime)
- **Code signing**: **None** — Linux desktop binaries are unsigned. Verify checksums published on the GitHub Releases page before deploying
- **Biometric helper**: macOS-only; not present on Linux
- **Passphrase caching**: `0600`-mode file (no system keychain integration on Linux desktop)

### Linux — headless / Docker (server mode)

- **Official image**: `ghcr.io/nehloo-interactive/graphnosis-app/graphnosis-server` (linux/amd64, linux/arm64)
- **Process**: Sidecar + browser UI only — no Tauri shell
- **Port**: `3456` (browser UI and HTTP MCP bridge)
- **Default bind**: `0.0.0.0` — **the image exposes port 3456 to the network by default.** Protect with `GRAPHNOSIS_HTTP_UI_TOKEN` and a reverse proxy or firewall rule
- **Cortex**: Mounted volume at `/data/cortex`; never baked into the image
- **User**: Runs as non-root `graphnosis` user inside the container
- **Embedding model**: Downloaded from `storage.googleapis.com` on first embed (~90 MB). Pre-bake into the image for air-gapped deployments — the Dockerfile includes commented instructions for this

### What installation does NOT do (all platforms)

- No elevated privileges or UAC prompts
- No kernel extensions, drivers, or system services
- No global registry pollution beyond the app shortcut and the `graphnosis://` deep-link URL scheme
- No background daemon that starts at login

---

## 2. What Graphnosis reads and writes from the host machine

### Filesystem writes

| Path | Contents | When written |
|---|---|---|
| `<cortex>/` (user-selected, default `~/GraphnosisCortex`) | `.gai` engrams, source indexes, op-log, content cache, snapshots, encryption key files, and write-lock | During cortex operation |
| `~/.graphnosis/mcp.sock` | Unix socket for MCP clients | On sidecar start |
| Passphrase cache (macOS dev/unsigned only) | File-based passphrase cache, user-only permissions | After first unlock |
| AI client config files (see Section 1) | MCP server path entry | On first AI client connect |
| `<app-data>/.window-state.json` | Window size/position | On window move/resize |

### OS credential store

- **macOS**: Keychain entry bound to the signed binary; cannot be read by other processes
- **Windows**: Credential Manager (DPAPI), scoped to the current OS user
- **Linux / unsigned builds**: File-based cache with user-only permissions

### Filesystem reads

Only within:

- The cortex folder you selected
- Paths you explicitly ingest (drag-and-drop, file picker, URL paste, connector-configured directories)

### What it never reads

- Browser history, email, calendar, or clipboard — none of these are accessed without an explicit ingest action
- Files outside the cortex folder or explicitly ingested paths

---

## 3. How the sidecar works in the background

The sidecar (`graphnosis-sidecar`) is a Bun-compiled Node.js binary bundled inside the app. It is **not** a system service and does **not** start at login.

### Lifecycle

1. **Lock screen shown** — sidecar not yet running
2. **User unlocks cortex** — Tauri shell spawns the sidecar as a supervised child process
3. **Sidecar acquires exclusive write lock** — single-writer guarantee; a second instance trying to open the same cortex exits with a clear error
4. **Local sockets open** — see table below
5. **IPC handshake** — Tauri shell waits for the socket to appear, then completes the unlock
6. **User quits / locks** — Tauri signals the sidecar to shut down gracefully; pending writes are flushed before exit; sockets and the write lock are released

### Sockets opened (all local — no network exposure by default)

| Socket | Purpose |
|---|---|
| Desktop IPC socket | Desktop app ↔ sidecar communication |
| Events socket | Push event stream to the UI |
| MCP socket (`~/.graphnosis/mcp.sock` on Unix; loopback TCP on Windows) | AI clients (Claude, Cursor, etc.) |

The MCP socket uses a fixed per-user path so AI clients remain configured across cortex switches. The IPC and events sockets are internal to the app and not reachable by external processes.

### What the sidecar accesses during normal operation

- Cortex folder (read + write)
- OS embedding model cache (`~/Library/Application Support/graphnosis-sidecar/` or equivalent; populated once on first use)
- Ollama at `http://127.0.0.1:11434` — only if the optional Local LLM is enabled
- `storage.googleapis.com` — one-time embedding model download on first use only

### Passphrase handling

The Tauri shell passes the passphrase to the sidecar via the `GRAPHNOSIS_PASSPHRASE` environment variable. For interactive desktop use this is handled entirely by the app and never touches a shell. For headless or scripted deployments (Docker, CI), prefer injecting the value from a secrets manager (Docker secrets, Kubernetes secrets, HashiCorp Vault) rather than a plain environment variable, which is visible to other processes running under the same OS user.

---

## 4. Can a bad actor tamper with Graphnosis?

### Can someone intercept or swap an update binary?

Each update is verified against a **minisign public key hardcoded in the app** before being applied. A tampered or substituted binary will not install. On macOS, the running `.app` is Gatekeeper-verified on every launch against the Developer ID signature.

### Can someone exfiltrate cortex files by copying them?

Every `.gai` engram is encrypted with **XChaCha20-Poly1305**, keyed from a data key derived via **Argon2id** from the user's passphrase. Without the passphrase (or the 24-word BIP-39 recovery phrase stored separately), the files are opaque ciphertext. The data key never leaves the machine.

### Can someone connect to the MCP socket and read memories without the user knowing?

The MCP socket is accessible to processes running as the **same OS user** — an intentional design choice that avoids extra authentication round-trips for same-user AI tools. The practical implication is that Graphnosis's application-layer controls sit above the OS user boundary, not below it: if the machine itself is compromised, endpoint protection rather than Graphnosis is the appropriate control.

The **optional HTTP MCP bridge** (port 3456) requires a Bearer token on every request and should be kept on its default loopback binding unless you have a specific cross-machine use case and appropriate network controls in place.

### Can someone corrupt the cortex silently?

Every engram file is integrity-checked on load via authenticated encryption (the MAC covers the entire ciphertext) and an additional inner checksum on the graph bundle. A corrupted file is **auto-quarantined** — removed from the active cortex, preserved for recovery, and the user is notified. Writes are atomic (write to a temporary file, flush to stable storage, then atomically rename), so a power loss or kill mid-write leaves either the old file intact or the new one fully written — never a partial state.

### Can a skill pack (`.gsk` file) deliver malicious code?

No. `.gsk` files contain only graph data (MessagePack payload, AES-256-GCM encrypted). They carry no executable code. Each file carries an **Ed25519 signature**; unsigned or badly-signed packs are rejected at import. Skills are text-based SOPs that drive AI tool calls; they are not scripts that execute on the host.

### Can the sidecar binary be silently replaced?

On **macOS**, any modification to the `.app` bundle breaks the Developer ID code signature and Gatekeeper will refuse to launch the app. On **Windows** and **Linux**, protecting the install directory via OS-level access controls (standard file permissions, read-only mounts) is the appropriate defence — the same principle that applies to any desktop application. For Linux deployments, verify checksums published on the GitHub Releases page.

---

## 5. What can go wrong in enterprise environments

This is an honest risk register. Each row describes a real scenario, its severity in a typical enterprise context, and the available mitigation.

| Scenario | Severity | Mitigation |
|---|---|---|
| **Update deployed before IT validation** | Medium | Block `github.com/nehloo-interactive/graphnosis-app` at the firewall for update-controlled environments. All updates are cryptographically signed before being applied, but there is no MDM-gated deployment channel today |
| **Machine-level compromise affects AI memory access** | High (if machine is compromised) | Graphnosis's controls operate at the application layer, not below the OS user boundary. A compromised machine requires endpoint protection (EDR/XDR); application-layer guardrails are not a substitute |
| **`GRAPHNOSIS_PASSPHRASE` set as a plain environment variable** | Medium | Acceptable for interactive desktop use (handled internally by the app); not recommended for headless or scripted deployments. Use a secrets manager (Docker secrets, Kubernetes secrets, HashiCorp Vault) to inject the value at runtime |
| **No persistent per-call MCP audit log** | Medium | Consent grant and revocation history is persisted and encrypted. Individual tool calls are tracked in-memory only. For per-call logging, pipe sidecar output to a SIEM or place a logging reverse proxy in front of the HTTP bridge |
| **Sensitive-data consent requires a running desktop UI** | Low | A headless fallback is available: a time-limited phrase displayed in the app's Settings, typed into the AI conversation to confirm access. This covers SSH, Docker, and CI deployments |
| **Multiple users on a shared machine** | Low | Each OS user account maintains an independent, separately encrypted cortex. Cortex files are owned by the OS user who created them and are not accessible to other accounts |
| **Corporate proxy blocks embedding model download on first run** | Low | Pre-stage the model file manually before deployment, or pre-bake it into the Docker image. The app operates fully offline once the model is present on disk |
| **Docker deployment with default network binding** | High | The official Docker image binds the browser UI to all interfaces by default; port 3456 is network-accessible. Always set a bearer token (`GRAPHNOSIS_HTTP_UI_TOKEN`) and restrict access via a reverse proxy or firewall. Set `GRAPHNOSIS_BIND=127.0.0.1` to restrict to loopback if remote access is not needed |
| **User copies cortex folder to personal cloud storage** | Medium | Cortex files are strongly encrypted and are not useful without the passphrase, but adding a cloud provider to the custody chain is an organisational risk. Enforce via MDM data-loss-prevention policies on the cortex folder path |
| **Connector credentials for third-party services** | Medium | Connector tokens (e.g. GitHub, Slack) are encrypted with the same key as all other cortex data. Use minimum-scope tokens and rotate them when personnel change |
| **Linux desktop: no code signing** | Medium | Verify checksums published on the GitHub Releases page before deploying `.deb` or `.AppImage` packages; consider building from source for high-assurance environments |
| **Embedding model download blocked in air-gapped environments** | Low | Pre-stage the model or pre-bake it into the Docker image. Embeddings can also be disabled entirely, with recall falling back to keyword matching |
| **Third-party local LLM (Ollama) telemetry** | Low | Graphnosis communicates with Ollama only on the loopback interface. Ollama's own data handling is governed by its own settings; configure it independently |
| **Sidecar process exits unexpectedly** | Low | All writes are atomic; the cortex is never left in a partial state. The app detects the exit and returns to the lock screen. For Docker deployments, configure a restart policy |

---

## 6. Guardrails and controls

### Built-in (no configuration needed)

- **XChaCha20-Poly1305** authenticated encryption + **Argon2id** key derivation for all cortex data
- OS-native credential store for passphrase caching — no plaintext passphrase files in production builds
- **Atomic fsync+rename writes** — no half-written state after crashes or kills
- **Auto-quarantine** on HMAC/MAC mismatch — corruption surfaces immediately and is never silently ignored
- **Single-writer cortex lock** — prevents concurrent write corruption
- **Update signature verification** (minisign) before any binary is applied
- **MCP rate limiting** — per-client recall rate cap prevents burst access patterns
- **Session replay blocker** — repeated near-identical queries are detected and blocked after natural retries
- **Sensitivity tiers** (`public` / `personal` / `sensitive`) with mandatory consent gate for sensitive data
- **Source-available codebase** (FSL-1.1) — auditable by your security team without NDA

### IT-configurable controls (environment variables)

| Variable | Effect |
|---|---|
| `GRAPHNOSIS_DISABLED_CONNECTORS=slack,github` | Blocks named connectors org-wide; they will not start even if configured |
| `GRAPHNOSIS_DISABLED_CLIENTS=cursor,claude-ai` | Rejects MCP tool calls from named AI clients |
| `GRAPHNOSIS_MANAGED_POLICY=1` | Marks policy as centrally managed; local user cannot loosen it from Settings |
| `GRAPHNOSIS_CORTEX=/path/to/managed/cortex` | Pins cortex location (e.g. to an encrypted volume or MDM-controlled path) |
| `GRAPHNOSIS_BIND=127.0.0.1` | Locks optional HTTP bridges to loopback (override Docker default of `0.0.0.0`) |
| `GRAPHNOSIS_HTTP_UI_TOKEN=<secret>` | Mandatory Bearer token for the HTTP MCP bridge and browser UI |
| `GRAPHNOSIS_EMBED_WORKERS=1` | Reduces embedding worker count for constrained hardware |
| `GRAPHNOSIS_EMBED_DISABLE=1` | Disables on-device embeddings entirely (debugging / constrained environments) |

A `policy.json` file placed in the cortex folder accepts the same `disabledConnectors`, `disabledClients`, and `managed` fields as the env vars, and merges with them. When `GRAPHNOSIS_MANAGED_POLICY=1`, the app UI cannot overwrite this file.

### User-configurable controls (Settings)

- **Session caps** (Settings → AI → Optional session caps): token budget, node budget, engram-breadth cap per AI session
- **Extra precaution mode** (Settings → AI): gate personal-tier recalls behind the same in-app consent click as sensitive-tier data
- **Client policies** (Settings → AI → Client policies): per-AI-client default (always-allow / ask-1h / ask-today / ask-every-time / never-allow)

### Current limitations (honest gaps)

| Gap | Impact | Workaround |
|---|---|---|
| No MDM configuration profile (`.mobileconfig` / `.admx`) | Policy deployment requires scripting env vars | Deploy via MDM's shell script or configuration-file delivery |
| No built-in update-check toggle | Cannot disable GitHub version check from the UI | Block `github.com/nehloo-interactive/graphnosis-app` at the network layer |
| No persistent per-call MCP audit log | Individual tool calls not durably logged | Pipe sidecar process output to a SIEM; reverse-proxy audit layer |
| No SAML/SSO | Each user unlocks their cortex independently | No workaround in current version |
| macOS App Sandbox not enabled | Broader filesystem access than a sandboxed app | Tracked; blocked by MCP socket path-length constraint |
| Linux passphrase caching to file | `0600` file rather than system keychain | Use full-disk encryption on the host; rotate passphrase regularly |
| Linux desktop: no code signing | Cannot verify binary integrity via OS | Verify SHA checksums from release page; build from source |

---

## 7. Industrial, SCADA, robotics, and off-grid deployments

Graphnosis can act as an **on-device AI memory layer** in industrial environments — a place for operators or autonomous agents to store and recall knowledge about processes, incidents, configurations, and SOPs, without any dependency on cloud connectivity.

### What works out of the box

**Inbound webhook connector (SCADA / historian integration)**

Any SCADA historian, PLC gateway, n8n/Zapier automation, or custom script can push data into Graphnosis by posting JSON to the local webhook server:

```
POST http://127.0.0.1:3458/webhook/<connectorId>/<token>
Content-Type: application/json

{ "text": "Pump P-201 cavitation alarm — 14:32 UTC", "label": "Alarm", "source": "DCS-UNIT-3" }
```

The event ingests into the target engram immediately. Per-connector UUID tokens prevent enumeration; rotate via Settings. The server binds to `127.0.0.1` by default; change the bind address with `GRAPHNOSIS_BIND` only if you need cross-machine posting and have appropriate network controls.

**File-watcher connector (log file ingestion)**

Configure a connector to watch a directory for new or modified files. Graphnosis ingests them within ~1.5 s of a file change; a full re-scan runs every 30 min for self-healing. Suitable for SCADA alarm logs, historian CSV exports, or robot task logs written to a shared mount.

**Air-gapped / off-grid operation**

After the one-time embedding model download (~90 MB, `BGE-small-en-v1.5`), Graphnosis operates 100% offline. For Docker deployments, pre-bake the model into the image at build time:

```dockerfile
# Uncomment these lines in the Dockerfile to bake the model at build time:
RUN cd apps/desktop-sidecar && node -e "const{FlagEmbedding,EmbeddingModel}=require('fastembed'); \
    FlagEmbedding.init({model:EmbeddingModel.BGESmallENV15,cacheDir:'/opt/graphnosis-models', \
    showDownloadProgress:false}).then(()=>console.log('warmed'))"
```

Pro license tokens are verified locally via Ed25519 signature — no periodic server check at runtime. The billing server is only contacted when the token is initially fetched; it is not required for ongoing operation.

**ARM64 hardware support**

The official Docker image is multi-arch (`linux/amd64`, `linux/arm64`). Runs on Raspberry Pi 4/5, NVIDIA Jetson, and industrial ARM gateways. The ONNX runtime selects the correct platform binary automatically.

### Port conflict check

| Graphnosis port | Default bind | OT protocol | OT port |
|---|---|---|---|
| 3456 | 127.0.0.1 (or 0.0.0.0 in Docker) | Modbus TCP | 502 |
| 3457 | 127.0.0.1 (hardcoded) | OPC-UA | 4840 |
| 3458 | 127.0.0.1 | DNP3 | 20000 |
| Unix socket | localhost only | EtherNet/IP | 44818 |
| — | — | BACnet | 47808 |

No conflicts with any standard industrial protocol port.

### Minimum hardware requirements

| Resource | Minimum | Notes |
|---|---|---|
| RAM | ~5 GB available | Bun/JSC allocator baseline; embedding workers add ~100 MB each |
| Disk | ~1 GB + cortex size | App + embedding model; cortex grows with ingested data |
| CPU | Any x86_64 or ARM64 | No GPU required; ONNX runs on CPU |
| Reduce RAM | `GRAPHNOSIS_EMBED_WORKERS=1` | Reduces to one worker process |
| Minimal mode | `GRAPHNOSIS_EMBED_DISABLE=1` | Disables embeddings; recall falls back to TF-IDF |

Industrial single-board computers with less than 4 GB RAM require tuning.

### OT-specific risks

| Scenario | Risk | Mitigation |
|---|---|---|
| Auto-update check on SCADA workstation (Windows HMI) | Outbound connection to GitHub at startup | Block `github.com/nehloo-interactive/graphnosis-app` at the OT/DMZ boundary |
| Webhook endpoint reachable from plant floor | Inbound injection into AI memory from a compromised segment | Bind to management-network interface only; enforce network segmentation |
| Docker with `GRAPHNOSIS_BIND=0.0.0.0` on OT server | Port 3456 reachable from the control network | Set `GRAPHNOSIS_BIND=<mgmt-interface-IP>`; add bearer token |
| Passphrase in Docker env on OT server | Visible in `docker inspect` to anyone with Docker socket access | Use Docker secrets, Kubernetes secrets, or HashiCorp Vault injection |
| Sidecar crash stops AI agent memory | Agent loses recall until restart | Configure Docker restart policy (`restart: unless-stopped`); use Kubernetes liveness probe |
| Embedded system < 4 GB RAM | OOM kill | `GRAPHNOSIS_EMBED_WORKERS=1`; optionally `GRAPHNOSIS_EMBED_DISABLE=1` |

### What is not supported

- **Native protocol connectors**: No Modbus, OPC-UA, DNP3, or EtherNet/IP drivers. Data must be translated to JSON by a gateway before posting to the webhook endpoint
- **Multi-writer HA**: One sidecar per cortex; single-writer by design. Coordinate restarts via an orchestrator rather than running parallel instances
- **Real-time process control**: Recall involves disk I/O and ONNX inference; not suitable as a real-time control data store

---

## 8. Compliance and regulatory mapping

This section maps Graphnosis's architecture to major regulatory frameworks. It is not legal advice. Where gaps exist they are named explicitly.

### Architectural properties relevant to compliance

| Property | Implementation |
|---|---|
| **Data residency — strictly local** | No Graphnosis / Nehloo server ever holds cortex data. Cortex never leaves the device or container unless the user manually copies it |
| **Encryption at rest** | XChaCha20-Poly1305 (AEAD, 256-bit key) + Argon2id key derivation |
| **Encryption in transit** | Local Unix socket (no network); optional HTTP bridge accepts TLS termination at the reverse proxy |
| **Explicit consent for sensitive data** | `sensitive`-tier engrams require an in-app modal click (or phrase entry) before AI access. Consent is recorded (id, timestamps, client, tier, duration) in encrypted cortex settings |
| **Right to erasure** | `forget` MCP tool (soft-delete nodes); source deletion via app UI. Data is never replicated to an external server, so erasure is local-only |
| **Right to portability** | `.gai` files are decryptable with passphrase + open-source Apache-2.0 SDK (`@nehloo/graphnosis`). No vendor lock-in |
| **No third-party AI API calls** | No data sent to OpenAI, Anthropic, Google, or any hosted LLM. Optional local LLM uses Ollama on-device only |
| **Deterministic recall** | Same query → same result; auditable. Non-deterministic features are opt-in and clearly labelled |

### GDPR (EU / UK GDPR)

- **Data controller**: the user. Nehloo Interactive is not a data processor for cortex content — it has no copy
- **Article 9 (special-category data)**: the `sensitive` tier maps directly to this; access always requires explicit in-app consent
- **Data subject rights** (access, rectification, erasure, portability): exercised locally via Settings → AI → Data tab
- **Data residency**: fully enforceable — cortex never crosses a border unless the user moves it. Docker deployments can be pinned to any jurisdiction
- **Data transfer to AI providers**: when a recall is allowed, the excerpt travels to the AI provider the user has configured — governed by that provider's DPA, not Graphnosis's. See [Using Graphnosis with AI Clients](/legal/third-party-ai/)
- **Nehloo's role**: holds only subscription email (billing); not an Article 28 processor for cortex content

### HIPAA (US healthcare)

- **PHI classification**: place patient-related engrams in a `sensitive`-tier engram — AI access always requires explicit consent; consent is logged
- **Encryption at rest (§164.312(a)(2)(iv))**: XChaCha20-Poly1305 satisfies the addressable encryption requirement
- **Access controls (§164.312(a)(1))**: OS-level user account separation + passphrase; no shared cortex across users
- **Audit controls (§164.312(b))**: Consent grant/revoke history is persisted and exportable. **Gap**: Individual recall queries are not durably logged — pipe sidecar output to a SIEM for per-query audit
- **BAA with Nehloo**: Not required — Nehloo never receives or processes PHI. If PHI recall results are sent to a cloud AI provider, a BAA with that provider is required
- **Minimum necessary**: Session caps, engram-breadth cap, and `only_engrams` MCP parameter support minimum-necessary principles

### CCPA / CPRA (California)

- Cortex data is stored on the user's device; Nehloo cannot respond to CCPA requests about cortex content — it does not possess it
- Users exercise access, deletion, and portability rights directly in the app

### FedRAMP / FISMA / NIST 800-53 (US federal)

- **Air-gapped operation**: fully supported (pre-bake embedding model; no runtime internet required)
- **Cryptographic module**: XChaCha20-Poly1305 and Argon2id are **not** on the FIPS 140-2 approved algorithm list. This is a hard blocker for FedRAMP High and DoD IL4+. [Contact us](/upgrade) if this is a requirement for your deployment
- **Audit log (NIST AU-2)**: Consent history covers consent events; per-tool-call logging requires an external audit layer
- **STIG/CIS hardening**: No published hardening guides; apply standard Node.js / Bun process hardening

### ITAR / EAR (US export controls, defense / aerospace)

- Air-gapped operation eliminates most data-exfiltration risk
- Encryption export classification: EAR 5E002 (mass-market encryption product; typically self-classifiable)

### IEC 62443 / NERC CIP (industrial / energy)

- Graphnosis sits on the IT/DMZ side; it does not interface directly with control systems
- **NERC CIP-007**: Document Graphnosis ports 3456-3458 in your Electronic Security Perimeter asset inventory; disable unused bridges
- Network segmentation: bind the sidecar to the management network interface only; never expose port 3456 to the OT zone

### FDA 21 CFR Part 11 (pharma / medical device / laboratory)

- Consent history is append-only and encrypted. Individual recall/ingest operations are not individually time-stamped with an electronic signature — **this is a gap** for Part 11 compliance
- Not a validated (IQ/OQ/PQ) system; organisations using Graphnosis in a regulated documentation workflow would need to include it in their computer system validation programme

### PCI-DSS (payment card)

- Cardholder data must not be ingested into Graphnosis unless the deployment is within a defined CDE with appropriate controls
- Encryption at rest satisfies PCI-DSS Requirement 3; there is no Graphnosis server in scope

### Compliance gap summary

| Gap | Affected frameworks | Workaround |
|---|---|---|
| No FIPS 140-2 validated crypto | FedRAMP High, DoD IL4+, some NIST profiles | [Contact us](/upgrade) to discuss; enforce FIPS at the TLS boundary layer in the interim |
| No persistent per-call MCP audit log | HIPAA §164.312(b), SOC 2, FDA 21 CFR Part 11, NIST AU-2 | Pipe sidecar output to SIEM; reverse-proxy audit layer |
| No SOC 2 Type II report | Enterprise procurement, financial services | Not yet available; source code enables customer-led audit |
| No BAA with Nehloo | HIPAA | Not needed — Nehloo never holds PHI; BAA required with the AI provider |
| No MDM policy profiles | macOS MDM, Windows ADMX | Deploy env vars + `policy.json` via MDM script delivery |
| Linux desktop: no code signing | Any framework requiring signed software | Verify checksums from release page; build from source |
| `GRAPHNOSIS_PASSPHRASE` env-var visibility | Any framework requiring secret management | Docker secrets / Kubernetes secrets / HashiCorp Vault |
| No multi-user RBAC | Healthcare, financial multi-operator environments | Each operator maintains a separate passphrase-protected cortex |

---

## Related

[What Leaves Your Device](/guides/network-activity/) — complete inventory of every outbound request, with source links.

[AI Access Controls](/guides/ai-access-controls/) — the five consent layers between AI clients and your memory.

[Keeping Your Cortex Safe](/guides/keeping-your-cortex-safe/) — passphrase, recovery phrase, encryption, atomic writes, and snapshots.

[Verify It Yourself](/guides/verify-it-yourself/) — how to independently confirm the privacy claims using a network monitor.

[Environment Variables](/reference/environment-variables/) — complete reference for all configurable variables including the admin policy group.

[File Formats](/reference/file-formats/) — the on-disk layout of `.gai`, `.gsk`, and related files.

[Using Graphnosis with AI Clients](/legal/third-party-ai/) — what the AI provider sees once a recall is allowed.
