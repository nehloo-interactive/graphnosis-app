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
