# Graphnosis personal-server launchers

Double-clickable / one-command starters for running the headless sidecar (the
browser UI on `:3456`) without babysitting a terminal. For an **always-on**
server, prefer the systemd unit or Docker (see `../linux/README.md`) — these
launchers are for **desktop** users who want to start a personal server on
demand.

| Platform | File | How |
|---|---|---|
| macOS | `graphnosis-server.command` | Double-click in Finder (first time: right-click → Open to clear Gatekeeper). |
| Linux | `graphnosis-server.sh` | `./graphnosis-server.sh`, or wire to a `.desktop` entry. |
| Windows | `graphnosis-server.bat` | Double-click. |

Each one: starts the sidecar in the background (if not already running), waits
for it to answer, and opens your browser to `http://127.0.0.1:3456/?token=…`.
The access token is generated once and persisted to
`$GRAPHNOSIS_STATE/http-ui-token` — by default `~/.graphnosis/http-ui-token`
(`%USERPROFILE%\.graphnosis\http-ui-token` on Windows). See
[`GRAPHNOSIS_STATE`](#config-all-optional) to put it somewhere else.

## Requirements

- **Node.js 20+** on `PATH`.
- The repo **built**: `pnpm install && pnpm -r build`. The launcher looks for the
  sidecar two levels up (`apps/desktop-sidecar/dist/index.js`); override the
  location with `GRAPHNOSIS_HOME`.

## The passphrase tradeoff

A double-click can't prompt, so the cortex passphrase must be available
non-interactively:

- set `GRAPHNOSIS_PASSPHRASE` in the environment, **or**
- put it in `$GRAPHNOSIS_STATE/passphrase` — by default `~/.graphnosis/passphrase`
  — with `chmod 600`.

Storing a passphrase in plaintext is a **conscious security tradeoff** — same as
the systemd unit's `GRAPHNOSIS_PASSPHRASE`. Only do it on a machine you trust.
Without it, the sidecar starts but the cortex stays locked.

## Config (all optional)

| Var | Default | Meaning |
|---|---|---|
| `GRAPHNOSIS_HOME` | two levels above the script | Repo / install root. |
| `GRAPHNOSIS_STATE` | `~/.graphnosis` (`%USERPROFILE%\.graphnosis`) | Machine-local state folder. Holds `http-ui-token`, `passphrase`, `server.log`, the license seed cache, catalog subscriptions + install state, the MDM catalog bundle, and remote-MCP bearer credentials. Point it somewhere else to run two independent server instances on one host, or to keep server state off `$HOME`. |
| `GRAPHNOSIS_CORTEX` | see note below | Cortex folder. |
| `GRAPHNOSIS_HTTP_UI_PORT` | `3456` | Browser-UI port. |
| `GRAPHNOSIS_HTTP_UI_TOKEN` | generated + persisted | Access token. |
| `GRAPHNOSIS_PASSPHRASE` | — | Cortex passphrase (see above). |

> **`GRAPHNOSIS_CORTEX` defaults differ by platform when `GRAPHNOSIS_STATE` is
> relocated.** With `GRAPHNOSIS_STATE` unset both launchers default the cortex to
> `~/.graphnosis/cortex`. With it set, `graphnosis-server.bat` derives the cortex
> from it (`%GRAPHNOSIS_STATE%\cortex`) while `graphnosis-server.sh` does not
> (`$HOME/.graphnosis/cortex`). Set `GRAPHNOSIS_CORTEX` explicitly whenever you
> relocate the state folder, so the cortex lands where you intend on every
> platform. Your cortex is your data — the launchers will not move it for you
> based on a guess.

## Stopping it

- macOS / Linux: `pkill -f 'desktop-sidecar/dist/index.js'`
- Windows: end the `node.exe` running the sidecar in Task Manager.

To reach it from your phone over Tailscale, see `../linux/README.md` (the same
`tailscale serve` HTTPS setup applies).

## Developing against a remote cortex (dev tooling)

This is for **contributors / power users** iterating on the sidecar while the
canonical cortex runs on a personal-server host (Mac Mini, home NAS, etc.).
It is **not** an end-user feature and is not exposed in the app UI.

### Layout

| Machine | Role | What runs |
|---|---|---|
| **Host** (Mini) | Always-on cortex + sidecar | Personal-server launcher / `dist/index.js` |
| **Guest** (laptop) | Thin-client UI | `pnpm dev:desktop` in remote mode → host over Tailscale/LAN |

- **UI-only** changes (`apps/desktop`) stay on the laptop — Vite serves them;
  the Mini needs no update.
- **Sidecar / IPC** changes must execute on the host. Push a local build over
  SSH instead of committing mid-flight WIP and pulling on the Mini.

### One-time host prep

1. Repo checkout on the host (default path the push script expects:
   `~/Developer/graphnosis-app` — override with `GRAPHNOSIS_HOST_REPO` if yours
   differs).
2. `pnpm install && pnpm -r build` once so `apps/desktop-sidecar/dist/` exists.
3. SSH key auth from laptop → host (works without a password). Use a Tailscale
   **MagicDNS / SSH** hostname (`you@your-host.tailnet-name.ts.net`), **not**
   the HTTPS personal-server URL. Install once with `ssh-copy-id`. The push
   script uses `BatchMode` and fails fast if a password would be required.
4. Passphrase available non-interactively for restart unlock:
   `~/.graphnosis/passphrase` (`chmod 600`) or `GRAPHNOSIS_PASSPHRASE` in the
   host environment — same tradeoff as [above](#the-passphrase-tradeoff).
   Headless sidecar **requires** this at process start (no unlock UI).
5. Know the **real cortex path** on the host (status bar / unlock folder in
   Graphnosis.app). You will set `GRAPHNOSIS_CORTEX` on the laptop to that
   path — see below.
6. `pnpm` and `node` must be on the host PATH for **login** SSH. Bare
   `ssh host pnpm` often fails (Homebrew/`corepack` only in `.zshrc`). From
   the laptop (after sourcing `.graphnosis-host.env`):
   `ssh "$GRAPHNOSIS_HOST" "bash -l -c 'command -v pnpm && command -v node && pnpm -v && node -v'"`.
   If missing: on the host `corepack enable && corepack prepare pnpm@latest --activate`
   and/or `brew install node pnpm`. Dist-only push:
   `GRAPHNOSIS_HOST_INSTALL=0 pnpm dev:sidecar-host`.

### One-time laptop prep

```bash
cp .graphnosis-host.env.example .graphnosis-host.env
# edit (gitignored only):
#   GRAPHNOSIS_HOST=you@your-host.tailnet-name.ts.net
#   GRAPHNOSIS_CORTEX=/absolute/path/to/cortex/on/host
#   GRAPHNOSIS_HOST_REPO=~/Developer/graphnosis-app   # if different
```

`.graphnosis-host.env` is gitignored. **Never** commit real MagicDNS names,
SSH logins, cortex paths you treat as private, access tokens, or passphrases.
Use placeholders in tracked docs and in `.graphnosis-host.env.example`.

`GRAPHNOSIS_HOST` must be loaded in the shell for ad-hoc SSH checks:

```bash
set -a; source .graphnosis-host.env; set +a
# empty $GRAPHNOSIS_HOST → "Could not resolve hostname"
```

### Commands (run on the laptop)

| Command | What it does |
|---|---|
| `pnpm dev:sidecar-host` | Build sidecar → rsync `dist/` → restart host sidecar |
| `pnpm dev:sidecar-host:watch` | Same on every `apps/desktop-sidecar/src` save (fast `tsc` by default) |
| `pnpm dev:sidecar-host:fast` | One-shot with `tsc` only (skip docs/skill-demo codegen) |

Script: [`scripts/dev-push-sidecar-host.sh`](../../scripts/dev-push-sidecar-host.sh).

Defaults (override via env or `.graphnosis-host.env`):

| Var | Default | Meaning |
|---|---|---|
| `GRAPHNOSIS_HOST` | *(required)* | SSH target (`user@host`) |
| `GRAPHNOSIS_CORTEX` | *(unset → host `~/.graphnosis/cortex`)* | Cortex folder **on the host** — set this |
| `GRAPHNOSIS_HOST_REPO` | `~/Developer/graphnosis-app` | Repo root on the host |
| `GRAPHNOSIS_HOST_INSTALL` | `auto` | Host `pnpm install` only when `package.json` / lockfile hashes differ |
| `GRAPHNOSIS_HOST_RESTART` | `1` | `pkill` + relaunch `node dist/index.js` (no browser open on host) |
| `GRAPHNOSIS_HOST_FAST` | `0` one-shot / `1` watch | `tsc` only vs full package `build` |
| `GRAPHNOSIS_HOST_SKIP_BUILD` | `0` | Push existing `dist/` without rebuilding |

### Headless vs Graphnosis.app on the host

The push restarts only the **headless** process:

```text
node …/apps/desktop-sidecar/dist/index.js   →  127.0.0.1:3456
```

It does **not** quit `Graphnosis.app`. That app keeps its own **bundled**
sidecar. For laptop thin-client + WIP testing:

- Prefer the headless server (or quit the `.app` so it isn’t holding the cortex
  / competing on ports).
- Connect the laptop to the **personal-server** URL (Tailscale serve / HTTPS),
  not to a local sidecar on the host’s desktop app.
- Process name to look for is `node` + `desktop-sidecar/dist/index.js`, not
  `graphnosis` / `sidecar`.

### Is the host sidecar up? (from the laptop)

```bash
set -a; source .graphnosis-host.env; set +a
ssh "$GRAPHNOSIS_HOST" 'bash -l -s' <<'EOF'
lsof -nP -iTCP:3456 -sTCP:LISTEN || echo "(nothing on :3456)"
pgrep -fl 'desktop-sidecar/dist/index.js' || echo "(no headless sidecar)"
curl -fsS -o /dev/null -w "%{http_code}\n" --max-time 2 http://127.0.0.1:3456/ || echo down
tail -n 30 ~/.graphnosis/server.log 2>/dev/null || true
EOF
```

Healthy: `node` listening on `127.0.0.1:3456`, curl not connection-refused.
Laptop **HTTP 502** usually means Tailscale reached the host but nothing is
healthy on `:3456`.

### Access token (laptop “token no longer valid”)

Restart **reuses** `~/.graphnosis/http-ui-token` on the host when present; it
does not rotate on every push. If the laptop still has an older token (e.g.
from Graphnosis.app browser access):

1. On the **host** (or via SSH): `cat ~/.graphnosis/http-ui-token`
2. Paste into the laptop unlock field **yourself**
3. Do not paste tokens into chat, commits, or tracked docs

### After a successful host restart

**Relock/reconnect** the laptop thin client so it re-reads host capabilities
(`cortex:capabilities`) and picks up new IPC.

### Troubleshooting (hard-won)

| Symptom | Likely cause | Fix |
|---|---|---|
| `ssh: Could not resolve hostname` with empty name | `$GRAPHNOSIS_HOST` not exported in this shell | `set -a; source .graphnosis-host.env; set +a` |
| `command not found: pnpm` / `node` on host install or restart | Non-login SSH PATH missing Homebrew | Script uses `bash -l`; verify with `bash -l -c 'command -v node'` |
| `Missing env var: GRAPHNOSIS_PASSPHRASE` | No host passphrase file | Create `~/.graphnosis/passphrase` (`chmod 600`) on host |
| Push said “up on :3456” but later nothing listens | Old: health-checked wrong process / `node` missing; or orphan watchdog | Current script requires **our** PID on the port; headless sets `GRAPHNOSIS_HTTP_UI=1` so orphaning after SSH closes does **not** exit the sidecar |
| `parent process died; exiting cleanly` right after start | Sidecar treated SSH disconnect as Tauri death | Fixed when host runs a build with `GRAPHNOSIS_HTTP_UI=1` skipping that watchdog — re-push |
| Wrong / empty cortex on host | Defaulted to `~/.graphnosis/cortex` | Set `GRAPHNOSIS_CORTEX` in `.graphnosis-host.env` to the real host path |
| Laptop: access token invalid | Token mismatch | `cat ~/.graphnosis/http-ui-token` on host; paste locally |
| Laptop: HTTP 502 | Proxy up, backend down | Run the “is the host sidecar up?” probe; re-run `pnpm dev:sidecar-host` |

### What this is not

- Not a substitute for shipping releases (still commit, changelog, tag).
- Not a code-delivery channel through the cortex/engrams — only SSH + `dist/`.
- Not required for end users running a personal server from a release build.
