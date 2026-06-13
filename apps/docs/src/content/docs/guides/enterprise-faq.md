---
title: Enterprise IT FAQ
description: Security, installation, system access, tamper resistance, OT/industrial integration, and compliance mapping for IT teams evaluating Graphnosis in enterprise environments.
sidebar:
  order: 8
---

This page answers the questions enterprise IT, infosec, and compliance teams reliably ask before approving Graphnosis. It is written to be straightforward — including about current limitations — rather than to be a marketing document.

**TL;DR:** Graphnosis is a local, encrypted, user-owned memory store with no cloud back-end. All data stays on the device or container you deploy it on. The app makes one automatic outbound connection (a GitHub version check on startup), requires no elevated privileges, and exposes no network-accessible endpoints by default. IT policy controls are available via environment variables. Where current limitations exist they are documented below, along with the available mitigations and the roadmap status.

:::note[This page is kept current]
As limitations are addressed, this page is updated and the changes are announced in the [Changelog](/changelog) and via in-app release notes. If you are evaluating Graphnosis for an enterprise deployment and have requirements not covered here, [contact us](/upgrade).
:::

---

## 1. Installation — Windows, macOS, and Linux

### macOS

- **Installer format**: DMG containing a signed `.app` bundle
- **Code signing**: Developer ID Application — Nehloo Interactive LLC (Team ID: `C76ZLJ5UQW`), verified by macOS Gatekeeper on every launch
- **Notarisation**: Yes; Apple's notarisation service has scanned the binary
- **Entitlements**: JIT compilation and unsigned executable memory, required by the WebKit rendering engine. The App Sandbox is not yet enabled — the IPC socket path used by MCP clients has a length constraint that requires a TCP-based redesign before sandboxing is feasible. This is tracked and planned
- **Bundled binaries**: `graphnosis-sidecar` (statically compiled, self-contained), `graphnosis-biometric` (Swift, Touch ID only), `graphnosis-mcp-relay`
- **Passphrase caching**: macOS Keychain (signed builds), bound to the signed binary via audit token. Developer/unsigned builds use a file-based cache with user-only permissions
- **Auto-start**: None — the sidecar starts only when the app is open and the cortex is unlocked

### Windows

- **Installer format**: MSI installer
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
- **Passphrase caching**: File-based cache restricted to the current OS user (no system keychain integration on Linux desktop; on the roadmap)

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

The sidecar (`graphnosis-sidecar`) is a self-contained binary bundled inside the app. It is **not** a system service and does **not** start at login.

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

## 4. Tamper resistance and data protection

### Update integrity

Each update is verified against a **minisign public key hardcoded in the app** before being applied. A tampered or substituted binary will not install. On macOS, the running `.app` is Gatekeeper-verified on every launch against the Developer ID signature.

### Data exfiltration via file copy

Every `.gai` engram is encrypted with **XChaCha20-Poly1305**, keyed from a data key derived via **Argon2id** from the user's passphrase. Without the passphrase (or the 24-word BIP-39 recovery phrase stored separately), the files are opaque ciphertext. The data key never leaves the machine.

### MCP socket access boundary

The MCP socket is accessible to processes running as the **same OS user** — an intentional design choice that avoids extra authentication round-trips for same-user AI tools. The practical implication is that Graphnosis's application-layer controls sit above the OS user boundary, not below it: if the machine itself is compromised, endpoint protection rather than Graphnosis is the appropriate control.

The **optional HTTP MCP bridge** (port 3456) requires a Bearer token on every request and should be kept on its default loopback binding unless you have a specific cross-machine use case and appropriate network controls in place.

### Data integrity and corruption protection

Every engram file is integrity-checked on load via authenticated encryption (the MAC covers the entire ciphertext) and an additional inner checksum on the graph bundle. A corrupted file is **auto-quarantined** — removed from the active cortex, preserved for recovery, and the user is notified. Writes are atomic (write to a temporary file, flush to stable storage, then atomically rename), so a power loss or kill mid-write leaves either the old file intact or the new one fully written — never a partial state.

### Skill pack (`.gsk` file) safety

`.gsk` files contain only graph data (encrypted, signed with Ed25519). They carry no executable code and cannot run anything on the host. Packs that fail signature verification are rejected at import.

### Binary integrity

On **macOS**, any modification to the `.app` bundle breaks the Developer ID code signature and Gatekeeper will refuse to launch the app. On **Windows** and **Linux**, protecting the install directory via OS-level access controls (standard file permissions, read-only mounts) is the appropriate defence — the same principle that applies to any desktop application. For Linux deployments, verify checksums published on the GitHub Releases page.

---

## 5. Deployment security checklist

The following table covers deployment considerations that enterprise IT teams commonly review. Most entries are standard configuration steps rather than product deficiencies — the same considerations apply to any local-first desktop or container application.

| Consideration | Action required | Notes |
|---|---|---|
| **Update deployment channel** | Configure for your environment | By default the app checks for updates on startup and prompts the user to install. For environments that require IT-validated updates, block the update endpoint at the firewall and deploy updates through your standard software distribution process. All updates are cryptographically signed |
| **Headless / Docker passphrase injection** | Use a secrets manager | For Docker and scripted deployments, inject the passphrase via Docker secrets, Kubernetes secrets, or a vault integration rather than a plain environment variable. Interactive desktop deployments are handled entirely within the app |
| **Docker network binding** | Set before deploying | The official Docker image exposes the browser UI on all interfaces by default to support reverse-proxy deployments. Set `GRAPHNOSIS_BIND=127.0.0.1` to restrict to loopback, or place the container behind a reverse proxy with TLS and access controls. A bearer token (`GRAPHNOSIS_HTTP_UI_TOKEN`) is required in all cases |
| **Per-call MCP audit logging** | Integrate with existing SIEM | Consent grants and revocations are logged persistently. Individual tool-call logging requires routing sidecar output to a SIEM or adding a logging reverse proxy. A native per-call audit log is on the roadmap |
| **Sensitive-data consent in headless environments** | Verify fallback works for your setup | The in-app consent modal works when a desktop GUI is available. For headless deployments (SSH, Docker, CI), a time-limited phrase shown in Settings provides the equivalent confirmation |
| **Multi-user shared machines** | No action needed | Each OS user account has an independent, separately encrypted cortex not accessible to other accounts |
| **Air-gapped or proxy-restricted environments** | Pre-stage the embedding model | The embedding model (~90 MB) downloads once on first use. Pre-stage it before deployment or pre-bake it into the Docker image; the application operates fully offline after that |
| **User-initiated cortex backup to cloud storage** | Enforce via MDM DLP policy | Cortex files are strongly encrypted and require the user's passphrase to be useful. If organisational policy prohibits cloud backup of work data, apply data-loss-prevention rules to the cortex folder path |
| **Connector credentials for integrated services** | Follow principle of least privilege | Integration tokens (e.g. for GitHub or Slack) are encrypted with the same key as all other cortex data. Grant minimum-scope tokens and rotate them when personnel change |
| **Linux desktop binary verification** | Verify checksums before deployment | Linux desktop packages are not code-signed. Verify the SHA checksums published on the GitHub Releases page before deploying; for high-assurance environments, build from source |
| **Machine-level security** | Covered by your existing endpoint protection | Graphnosis's access controls operate at the application layer. Like all desktop applications, defence at the machine level — full-disk encryption, EDR/XDR, locked-down user accounts — is the foundation |
| **Third-party local LLM (Ollama) configuration** | Configure Ollama independently | Graphnosis communicates with Ollama on the loopback interface only. Ollama's own privacy settings are outside Graphnosis's scope |

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

### Current limitations

Graphnosis is actively working on all items below. As each is addressed, this page is updated and the change is announced in the [Changelog](/changelog) and via in-app release notes.

| Limitation | Impact | Current mitigation |
|---|---|---|
| No MDM configuration profile (`.mobileconfig` / `.admx`) | Policy must be deployed via scripted environment variables rather than an MDM payload | All policy settings are available as environment variables and a `policy.json` file, both of which can be deployed via MDM shell-script or file-delivery mechanisms |
| No built-in update-check toggle | The update check cannot be disabled from the Settings UI | Block the update endpoint at the network layer for environments that require IT-controlled update deployment |
| No persistent per-call MCP audit log | Individual AI tool calls are not durably logged | Route sidecar process output to a SIEM, or add a logging reverse proxy in front of the HTTP MCP bridge |
| No SAML/SSO integration | Each user authenticates with their own passphrase | Each cortex is independently encrypted; passphrase management follows your existing credential policies. SSO integration is on the roadmap |
| macOS App Sandbox pending | The app runs with standard user-level permissions rather than the tighter macOS App Sandbox | Access is bounded to the user-selected cortex folder and explicitly ingested paths; no access to system directories, browser data, or other user files |
| Linux system keychain integration pending | Passphrase cache uses a user-restricted file rather than a system keychain | Use full-disk encryption on the host to protect the cached passphrase at rest. Linux keychain integration is on the roadmap |
| Linux desktop code signing pending | Binary integrity cannot be verified via OS-level signature check | Verify SHA checksums published on the GitHub Releases page before deploying; build from source for high-assurance environments |

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
| Passphrase configured as a plain environment variable | Access to the Docker daemon should be appropriately restricted; prefer secrets injection | Use Docker secrets, Kubernetes secrets, or HashiCorp Vault to inject the passphrase at runtime |
| Sidecar crash stops AI agent memory | Agent loses recall until restart | Configure Docker restart policy (`restart: unless-stopped`); use Kubernetes liveness probe |
| Embedded system < 4 GB RAM | OOM kill | `GRAPHNOSIS_EMBED_WORKERS=1`; optionally `GRAPHNOSIS_EMBED_DISABLE=1` |

### Current OT limitations

- **Native protocol connectors**: Modbus, OPC-UA, DNP3, and EtherNet/IP are not natively supported. Data must be translated to JSON by a gateway or middleware layer before posting to the webhook endpoint. Native connectors are on the roadmap
- **High-availability clustering**: The single-writer architecture ensures data integrity; HA is achieved through orchestrator-managed restarts (Docker restart policy, Kubernetes liveness probe) rather than parallel instances
- **Real-time process control**: Graphnosis is a knowledge and memory layer, not a real-time data bus. Recall latency is appropriate for operator-assistance and agent-memory use cases, not for sub-second control loops

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
- **Audit controls (§164.312(b))**: Consent grant/revoke history is persisted and exportable. Individual recall queries are not yet durably logged — pipe sidecar output to a SIEM for per-query audit; a native per-call audit log is on the roadmap
- **BAA with Nehloo**: Not required — Nehloo never receives or processes PHI. If PHI recall results are sent to a cloud AI provider, a BAA with that provider is required
- **Minimum necessary**: Session caps, engram-breadth cap, and `only_engrams` MCP parameter support minimum-necessary principles

### CCPA / CPRA (California)

- Cortex data is stored on the user's device; Nehloo cannot respond to CCPA requests about cortex content — it does not possess it
- Users exercise access, deletion, and portability rights directly in the app

### FedRAMP / FISMA / NIST 800-53 (US federal)

- **Air-gapped operation**: fully supported (pre-bake embedding model; no runtime internet required)
- **Cryptographic module**: XChaCha20-Poly1305 and Argon2id are **not** on the FIPS 140-2 approved algorithm list. This is a hard blocker for FedRAMP High and DoD IL4+. [Contact us](/upgrade) if this is a requirement for your deployment
- **Audit log (NIST AU-2)**: Consent history covers consent events; per-tool-call logging requires an external audit layer
- **STIG/CIS hardening**: Hardening guides are not yet published; apply standard OS and process hardening for your platform. A hardening guide is on the roadmap

### ITAR / EAR (US export controls, defense / aerospace)

- Air-gapped operation eliminates most data-exfiltration risk
- Encryption export classification: EAR 5E002 (mass-market encryption product; typically self-classifiable)

### IEC 62443 / NERC CIP (industrial / energy)

- Graphnosis sits on the IT/DMZ side; it does not interface directly with control systems
- **NERC CIP-007**: Document Graphnosis ports 3456-3458 in your Electronic Security Perimeter asset inventory; disable unused bridges
- Network segmentation: bind the sidecar to the management network interface only; never expose port 3456 to the OT zone

### FDA 21 CFR Part 11 (pharma / medical device / laboratory)

- Consent history is append-only and encrypted. Individual recall/ingest operations are not yet individually time-stamped with an electronic signature — Part 11 compliant audit trails are on the roadmap
- Computer system validation (IQ/OQ/PQ) documentation is not yet available; organisations using Graphnosis in a regulated documentation workflow would need to include it in their own CSV programme in the interim

### PCI-DSS (payment card)

- Cardholder data must not be ingested into Graphnosis unless the deployment is within a defined CDE with appropriate controls
- Encryption at rest satisfies PCI-DSS Requirement 3; there is no Graphnosis server in scope

### Compliance roadmap

Graphnosis is actively working on the items below. Updates are announced in the [Changelog](/changelog) as each is addressed. For requirements not covered by the current mitigations, [contact us](/upgrade).

| Item | Affected frameworks | Current status and mitigation |
|---|---|---|
| FIPS 140-2 validated cryptographic module | FedRAMP High, DoD IL4+, some NIST profiles | Not yet available. Enforce FIPS at the TLS boundary layer in the interim; [contact us](/upgrade) to discuss your specific requirements |
| Persistent per-call MCP audit log | HIPAA §164.312(b), SOC 2, FDA 21 CFR Part 11, NIST AU-2 | Consent grant/revoke history is persisted. Per-call logging: route sidecar output to a SIEM or add a logging reverse proxy; native support on the roadmap |
| SOC 2 Type II report | Enterprise procurement, financial services | In progress. The source-available codebase (FSL-1.1) enables a customer-led or third-party audit in the interim |
| BAA with Nehloo | HIPAA | **Not required** — Nehloo never receives, stores, or processes PHI. If recalled PHI is sent to a cloud AI provider, a BAA with that provider is required |
| MDM configuration profiles (`.mobileconfig` / `.admx`) | macOS MDM, Windows ADMX | On the roadmap. Current alternative: deploy env vars and `policy.json` via MDM script or file-delivery |
| Linux desktop code signing | Frameworks requiring signed software distribution | On the roadmap. Current alternative: verify SHA checksums from the GitHub Releases page; build from source for high-assurance environments |
| Secrets manager integration for passphrase injection | Frameworks requiring managed secrets | Use Docker secrets, Kubernetes secrets, or HashiCorp Vault. Interactive desktop deployments are handled entirely within the app |
| Multi-user RBAC | Healthcare, financial multi-operator environments | Each operator maintains a separate, independently encrypted cortex. Shared cortex with role-based access is on the roadmap |

---

## Related

[What Leaves Your Device](/guides/network-activity/) — complete inventory of every outbound request, with source links.

[AI Access Controls](/guides/ai-access-controls/) — the five consent layers between AI clients and your memory.

[Keeping Your Cortex Safe](/guides/keeping-your-cortex-safe/) — passphrase, recovery phrase, encryption, atomic writes, and snapshots.

[Verify It Yourself](/guides/verify-it-yourself/) — how to independently confirm the privacy claims using a network monitor.

[Environment Variables](/reference/environment-variables/) — complete reference for all configurable variables including the admin policy group.

[File Formats](/reference/file-formats/) — the on-disk layout of `.gai`, `.gsk`, and related files.

[Using Graphnosis with AI Clients](/legal/third-party-ai/) — what the AI provider sees once a recall is allowed.

---

## Explore by use case

→ [**Enterprise**](/for/enterprise) — SSO provisioning, audit log export, org-scale deployment  
→ [**Regulated**](/for/regulated) — HIPAA, SOC 2, GDPR, ISO 27001 — compliance-first deployments  
→ [**Air-gapped**](/for/air-gapped) — zero internet dependency, SCADA/OT, classified environments
