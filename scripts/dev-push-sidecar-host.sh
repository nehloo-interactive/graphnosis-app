#!/usr/bin/env bash
# A→Z: build laptop sidecar → rsync to personal-server host → restart host.
# No git commit / push / GitHub pull.
#
# One shot:
#   GRAPHNOSIS_HOST=nelu@mac-mini pnpm dev:sidecar-host
#
# Watch (rebuild+push on src changes):
#   GRAPHNOSIS_HOST=nelu@mac-mini pnpm dev:sidecar-host:watch
#
# Persist the host once (gitignored):
#   cp .graphnosis-host.env.example .graphnosis-host.env   # edit HOST=
#   pnpm dev:sidecar-host
#
# Env (HOST required, or set in .graphnosis-host.env):
#   GRAPHNOSIS_HOST                 SSH target (user@host) — NOT the HTTPS cortex URL
#   GRAPHNOSIS_HOST_REPO            Repo on host (default ~/Developer/graphnosis-app)
#   GRAPHNOSIS_CORTEX               Cortex folder on the HOST (strongly recommended)
#   GRAPHNOSIS_HOST_SKIP_BUILD=1    Skip local build
#   GRAPHNOSIS_HOST_FAST=1          tsc only (skip docs/skill-demo codegen)
#   GRAPHNOSIS_HOST_INSTALL=auto|0|1  (default auto)
#   GRAPHNOSIS_HOST_RESTART=0|1     (default 1)
#   GRAPHNOSIS_HOST_WATCH=1         Watch src and re-push
#   GRAPHNOSIS_HOST_WATCH_DEBOUNCE_MS  (default 1500)
#
# Never put real MagicDNS names, tokens, or passphrases in tracked files —
# only in gitignored .graphnosis-host.env (see .graphnosis-host.env.example).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -f "$ROOT/.graphnosis-host.env" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$ROOT/.graphnosis-host.env"; set +a
fi

HOST="${GRAPHNOSIS_HOST:?Set GRAPHNOSIS_HOST (e.g. you@mac-mini) or write it to .graphnosis-host.env}"
REMOTE_REPO="${GRAPHNOSIS_HOST_REPO:-~/Developer/graphnosis-app}"
# Absolute or ~/… path on the HOST. Empty → remote default ~/.graphnosis/cortex
# (often NOT the cortex Graphnosis.app uses — set this explicitly).
HOST_CORTEX="${GRAPHNOSIS_CORTEX:-}"
SRC="$ROOT/apps/desktop-sidecar"
SKIP_BUILD="${GRAPHNOSIS_HOST_SKIP_BUILD:-0}"
INSTALL_MODE="${GRAPHNOSIS_HOST_INSTALL:-auto}"
RESTART="${GRAPHNOSIS_HOST_RESTART:-1}"
WATCH="${GRAPHNOSIS_HOST_WATCH:-0}"
DEBOUNCE_MS="${GRAPHNOSIS_HOST_WATCH_DEBOUNCE_MS:-1500}"

# Watch defaults to fast tsc; one-shot defaults to full build unless FAST=1.
if [[ "$WATCH" == "1" ]]; then
  FAST="${GRAPHNOSIS_HOST_FAST:-1}"
else
  FAST="${GRAPHNOSIS_HOST_FAST:-0}"
fi

remote() {
  # shellcheck disable=SC2029
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" "$@"
}

# Non-interactive SSH often lacks Homebrew / corepack / pnpm from .zshrc.
# Run via login shell + stdin so PATH/tilde quoting stays sane.
remote_login() {
  local cmd="$1"
  # shellcheck disable=SC2029
  remote "bash -l -s" <<EOF
set -euo pipefail
export PATH="\$HOME/Library/pnpm:\$HOME/.local/share/pnpm:/opt/homebrew/bin:/usr/local/bin:\$PATH"
${cmd}
EOF
}

# Fail fast with a clear fix — do not treat SSH failure as "deps changed".
ensure_ssh() {
  echo "→ check SSH → $HOST"
  local err
  err="$(remote "echo ok" 2>&1)" && return 0
  # BatchMode SSH failures are often DNS / Tailscale-down / wrong user —
  # not only "publickey". Surface the real ssh line.
  cat >&2 <<EOF
SSH to $HOST failed.

ssh said:
  ${err:-'(no stderr)'}

GRAPHNOSIS_HOST must be an SSH login (user@host or an ~/.ssh/config Host alias),
not a Tailscale HTTPS cortex URL.

Quick checks on the laptop:
  1) Tailscale is connected (MagicDNS names only resolve when it is)
  2) Non-interactive SSH works:
       ssh -o BatchMode=yes $HOST 'echo ok'
  3) If you already have a working alias (e.g. Host agents-host in ~/.ssh/config
     with IdentityFile + User), set that in .graphnosis-host.env instead:
       GRAPHNOSIS_HOST=agents-host
  4) First-time key install (interactive Terminal, once):
       ssh-copy-id $HOST

Also confirm the repo exists on the Mini:
  ssh $HOST 'ls $REMOTE_REPO/apps/desktop-sidecar/package.json'
EOF
  exit 1
}

ensure_remote_pnpm() {
  if remote_login 'command -v pnpm >/dev/null'; then
    return 0
  fi
  cat >&2 <<EOF
Host $HOST has no pnpm on PATH for non-interactive SSH.

On the Mini (interactive Terminal once):
  corepack enable && corepack prepare pnpm@latest --activate
  # or: brew install pnpm

Verify from the laptop:
  ssh $HOST "bash -l -c 'command -v pnpm && pnpm -v'"

Or skip host install this run (dist-only push):
  GRAPHNOSIS_HOST_INSTALL=0 pnpm dev:sidecar-host
EOF
  exit 1
}

build_local() {
  if [[ "$SKIP_BUILD" == "1" ]]; then
    echo "→ skip build (GRAPHNOSIS_HOST_SKIP_BUILD=1)"
  elif [[ "$FAST" == "1" ]]; then
    # Sidecar imports workspace @graphnosis-app/core — build both or the Mini
    # boots against a stale core dist and dies on missing named exports.
    echo "→ fast build (core + sidecar tsc)"
    pnpm --filter @graphnosis-app/core build
    pnpm --filter @graphnosis-app/desktop-sidecar exec tsc -p tsconfig.json
  else
    echo "→ build @graphnosis-app/core + desktop-sidecar"
    pnpm --filter @graphnosis-app/core build
    pnpm --filter @graphnosis-app/desktop-sidecar build
  fi
  if [[ ! -f "$SRC/dist/index.js" ]]; then
    echo "No $SRC/dist/index.js after build" >&2
    exit 1
  fi
  if [[ ! -f "$ROOT/packages/graphnosis-app-core/dist/settings/index.js" ]]; then
    echo "No packages/graphnosis-app-core/dist after build" >&2
    exit 1
  fi
}

sha_local() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

needs_install() {
  case "$INSTALL_MODE" in
    1|true|yes) return 0 ;;
    0|false|no) return 1 ;;
  esac
  local local_pkg local_lock remote_pkg remote_lock
  local_pkg="$(sha_local "$SRC/package.json")"
  local_lock="$(sha_local "$ROOT/pnpm-lock.yaml")"
  # Prefer failing loudly over "empty hash ⇒ deps changed".
  remote_pkg="$(remote_login "cd $REMOTE_REPO && shasum -a 256 apps/desktop-sidecar/package.json | awk '{print \$1}'")"
  remote_lock="$(remote_login "cd $REMOTE_REPO && shasum -a 256 pnpm-lock.yaml | awk '{print \$1}'")"
  [[ "$local_pkg" != "$remote_pkg" || "$local_lock" != "$remote_lock" ]]
}

push_dist() {
  # Host workspace links apps/desktop-sidecar → packages/graphnosis-app-core.
  # Dist-only sidecar sync leaves core stale; new named imports then crash boot.
  echo "→ rsync core dist → $HOST:$REMOTE_REPO/packages/graphnosis-app-core/dist/"
  rsync -az --delete \
    --exclude '*.map' \
    "$ROOT/packages/graphnosis-app-core/dist/" \
    "$HOST:$REMOTE_REPO/packages/graphnosis-app-core/dist/"
  echo "→ rsync sidecar dist → $HOST:$REMOTE_REPO/apps/desktop-sidecar/dist/"
  rsync -az --delete \
    --exclude '*.map' \
    "$SRC/dist/" \
    "$HOST:$REMOTE_REPO/apps/desktop-sidecar/dist/"
}

push_deps_and_install() {
  echo "→ deps changed — sync package.json + lockfile, pnpm install on host"
  ensure_remote_pnpm
  rsync -az "$SRC/package.json" "$HOST:$REMOTE_REPO/apps/desktop-sidecar/package.json"
  rsync -az "$ROOT/pnpm-lock.yaml" "$HOST:$REMOTE_REPO/pnpm-lock.yaml"
  remote_login "cd $REMOTE_REPO && pnpm --filter @graphnosis-app/desktop-sidecar install --frozen-lockfile"
}

restart_host() {
  if [[ -z "$HOST_CORTEX" ]]; then
    echo "⚠ GRAPHNOSIS_CORTEX unset — host will open \$HOME/.graphnosis/cortex" >&2
    echo "  That is often NOT the folder Graphnosis.app uses. Set GRAPHNOSIS_CORTEX" >&2
    echo "  in .graphnosis-host.env to the real cortex path on the host." >&2
  else
    echo "→ host cortex $HOST_CORTEX"
  fi
  echo "→ restart host sidecar (no browser open on Mini)"
  # Login shell so Homebrew node/pnpm are on PATH (bare ssh often has neither).
  # Pass CORTEX_OVERRIDE from the laptop — quoted heredoc cannot see local env.
  # shellcheck disable=SC2029
  remote "REPO='$REMOTE_REPO' CORTEX_OVERRIDE=$(printf '%q' "$HOST_CORTEX") bash -l -s" <<'EOF'
set -euo pipefail
export PATH="$HOME/Library/pnpm:$HOME/.local/share/pnpm:/opt/homebrew/bin:/usr/local/bin:$PATH"
REPO="${REPO/#\~/$HOME}"
SIDECAR="$REPO/apps/desktop-sidecar/dist/index.js"
STATE_DIR="${GRAPHNOSIS_STATE:-$HOME/.graphnosis}"
if [[ -n "${CORTEX_OVERRIDE:-}" ]]; then
  CORTEX="$CORTEX_OVERRIDE"
else
  CORTEX="${GRAPHNOSIS_CORTEX:-$HOME/.graphnosis/cortex}"
fi
CORTEX="${CORTEX/#\~/$HOME}"
PORT="${GRAPHNOSIS_HTTP_UI_PORT:-3456}"
LOG="$STATE_DIR/server.log"
mkdir -p "$STATE_DIR"
echo "cortex=$CORTEX"

NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  echo "node not found on host PATH (tried login shell + Homebrew). Install Node or fix PATH." >&2
  exit 1
fi
echo "using $NODE ($($NODE -v))"

TOKEN_FILE="$STATE_DIR/http-ui-token"
if [[ -n "${GRAPHNOSIS_HTTP_UI_TOKEN:-}" ]]; then
  TOKEN="$GRAPHNOSIS_HTTP_UI_TOKEN"
elif [[ -f "$TOKEN_FILE" ]]; then
  TOKEN="$(cat "$TOKEN_FILE")"
else
  TOKEN="$(openssl rand -hex 32)"
  printf '%s' "$TOKEN" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
fi

PASS_FILE="$STATE_DIR/passphrase"
if [[ -z "${GRAPHNOSIS_PASSPHRASE:-}" && -f "$PASS_FILE" ]]; then
  GRAPHNOSIS_PASSPHRASE="$(cat "$PASS_FILE")"
fi
# Headless sidecar requires this at process start (no unlock UI).
if [[ -z "${GRAPHNOSIS_PASSPHRASE:-}" ]]; then
  cat >&2 <<HINT
Missing GRAPHNOSIS_PASSPHRASE on the host.

Graphnosis.app can unlock interactively; the headless personal-server
sidecar cannot. On the Mini, once:

  printf '%s' 'YOUR_CORTEX_PASSPHRASE' > ~/.graphnosis/passphrase
  chmod 600 ~/.graphnosis/passphrase

(or export GRAPHNOSIS_PASSPHRASE in the host environment). Same tradeoff
as deploy/launcher/README.md — plaintext on a machine you trust.
HINT
  exit 1
fi

pkill -f 'desktop-sidecar/dist/index.js' 2>/dev/null || true
sleep 0.6

if [[ ! -f "$SIDECAR" ]]; then
  echo "missing $SIDECAR" >&2
  exit 1
fi

{
  echo "---- restart $(date -u +%Y-%m-%dT%H:%M:%SZ) node=$NODE ----"
} >>"$LOG"

GRAPHNOSIS_HTTP_UI=1 \
GRAPHNOSIS_HTTP_UI_PORT="$PORT" \
GRAPHNOSIS_HTTP_UI_TOKEN="$TOKEN" \
GRAPHNOSIS_CORTEX="$CORTEX" \
GRAPHNOSIS_STATE="$STATE_DIR" \
GRAPHNOSIS_PASSPHRASE="$GRAPHNOSIS_PASSPHRASE" \
GRAPHNOSIS_HOME="$REPO" \
nohup "$NODE" "$SIDECAR" >>"$LOG" 2>&1 &
PID=$!
sleep 0.3
if ! kill -0 "$PID" 2>/dev/null; then
  echo "sidecar exited immediately — last log lines:" >&2
  tail -n 40 "$LOG" >&2 || true
  exit 1
fi

for _ in $(seq 1 40); do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "sidecar died during startup — last log lines:" >&2
    tail -n 40 "$LOG" >&2 || true
    exit 1
  fi
  # Require OUR pid on the port — Graphnosis.app on :3456 used to false-pass.
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | grep -q " $PID "; then
    echo "host HTTP UI up on :$PORT (pid $PID, headless node — not Graphnosis.app)"
    exit 0
  fi
  sleep 0.5
done
echo "host not answering on :$PORT yet — check $LOG (pid $PID still running=$(kill -0 "$PID" 2>/dev/null && echo yes || echo no))" >&2
exit 1
EOF
}

push_once() {
  local started
  started="$(date +%s)"
  ensure_ssh
  build_local
  # Dist-only is enough when deps already match. INSTALL=auto may still want
  # pnpm for the hash check path when package.json differs — ensure it exists
  # before we claim "deps changed".
  if needs_install; then
    push_deps_and_install
  else
    echo "→ deps unchanged — skip host pnpm install"
  fi
  push_dist
  if [[ "$RESTART" == "1" ]]; then
    restart_host
  else
    echo "→ skip restart (GRAPHNOSIS_HOST_RESTART=0)"
  fi
  echo "✓ sidecar host sync done in $(($(date +%s) - started))s → $HOST"
  echo "  look for: node …/desktop-sidecar/dist/index.js on :3456 (not a process named graphnosis)"
}

watch_loop() {
  echo "→ watch mode: $SRC/src (debounce ${DEBOUNCE_MS}ms, fast=$FAST). Ctrl-C to stop."
  push_once
  if command -v fswatch >/dev/null 2>&1; then
    fswatch -o \
      --latency "$(awk "BEGIN{print $DEBOUNCE_MS/1000}")" \
      "$SRC/src" "$SRC/package.json" \
      | while read -r _; do
          echo ""
          echo "── change detected $(date +%H:%M:%S) ──"
          push_once || echo "push failed — watching continues" >&2
        done
  else
    echo "  (fswatch missing — polling every 2s; brew install fswatch for better watch)"
    local stamp=""
    while true; do
      local now
      now="$(find "$SRC/src" "$SRC/package.json" -type f -print0 2>/dev/null \
        | xargs -0 stat -f '%m' 2>/dev/null | sort -n | tail -1 || true)"
      if [[ -n "$now" && "$now" != "$stamp" ]]; then
        if [[ -n "$stamp" ]]; then
          echo ""
          echo "── change detected $(date +%H:%M:%S) ──"
          sleep "$(awk "BEGIN{print $DEBOUNCE_MS/1000}")"
          push_once || echo "push failed — watching continues" >&2
          now="$(find "$SRC/src" "$SRC/package.json" -type f -print0 2>/dev/null \
            | xargs -0 stat -f '%m' 2>/dev/null | sort -n | tail -1 || true)"
        fi
        stamp="$now"
      fi
      sleep 2
    done
  fi
}

if [[ "$WATCH" == "1" ]]; then
  watch_loop
else
  push_once
fi
