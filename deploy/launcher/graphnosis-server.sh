#!/usr/bin/env bash
# Graphnosis personal-server launcher (macOS / Linux).
#
# Starts the headless sidecar (browser UI on :3456) in the background and opens
# your browser to it — no terminal babysitting required. Double-click
# `graphnosis-server.command` on macOS, or run this script on Linux. If the
# server is already running, it just opens the browser.
#
# Config (all optional — sensible defaults):
#   GRAPHNOSIS_HOME            repo/install root (default: two levels above this script)
#   GRAPHNOSIS_CORTEX          cortex folder        (default: ~/.graphnosis/cortex)
#   GRAPHNOSIS_HTTP_UI_PORT    UI port              (default: 3456)
#   GRAPHNOSIS_HTTP_UI_TOKEN   access token         (default: generated + persisted)
#   GRAPHNOSIS_PASSPHRASE      cortex passphrase    (REQUIRED to unlock; see below)
#
# Passphrase: a headless launch can't prompt, so the cortex passphrase must come
# from the environment OR a 0600-perms file at ~/.graphnosis/passphrase. Storing
# a passphrase in plaintext is a conscious tradeoff (same as the systemd unit) —
# only do it on a machine you trust.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO="${GRAPHNOSIS_HOME:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
SIDECAR="$REPO/apps/desktop-sidecar/dist/index.js"

PORT="${GRAPHNOSIS_HTTP_UI_PORT:-3456}"
CORTEX="${GRAPHNOSIS_CORTEX:-$HOME/.graphnosis/cortex}"
STATE_DIR="${GRAPHNOSIS_STATE:-$HOME/.graphnosis}"
mkdir -p "$STATE_DIR"

# ── Sanity ────────────────────────────────────────────────────────────────────
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "Node.js not found in PATH. Install Node 20+ and try again." >&2
  exit 1
fi
if [ ! -f "$SIDECAR" ]; then
  echo "Sidecar not built at: $SIDECAR" >&2
  echo "Run 'pnpm install && pnpm -r build' in the repo first, or set GRAPHNOSIS_HOME." >&2
  exit 1
fi

# ── Access token: reuse persisted, else generate ─────────────────────────────
TOKEN_FILE="$STATE_DIR/http-ui-token"
if [ -n "${GRAPHNOSIS_HTTP_UI_TOKEN:-}" ]; then
  TOKEN="$GRAPHNOSIS_HTTP_UI_TOKEN"
elif [ -f "$TOKEN_FILE" ]; then
  TOKEN="$(cat "$TOKEN_FILE")"
else
  TOKEN="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  printf '%s' "$TOKEN" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
fi

# ── Passphrase (env or 0600 file) ────────────────────────────────────────────
PASS_FILE="$STATE_DIR/passphrase"
if [ -z "${GRAPHNOSIS_PASSPHRASE:-}" ] && [ -f "$PASS_FILE" ]; then
  GRAPHNOSIS_PASSPHRASE="$(cat "$PASS_FILE")"
fi
if [ -z "${GRAPHNOSIS_PASSPHRASE:-}" ]; then
  echo "Note: GRAPHNOSIS_PASSPHRASE is not set. The cortex can't unlock without it —" >&2
  echo "      set the env var or create $PASS_FILE (chmod 600) before launching." >&2
fi

URL="http://127.0.0.1:$PORT/?token=$TOKEN"
LOG="$STATE_DIR/server.log"

is_up() { curl -fsS "http://127.0.0.1:$PORT/" >/dev/null 2>&1; }

# ── Start if not already running ─────────────────────────────────────────────
if is_up; then
  echo "Graphnosis server already running on :$PORT."
else
  echo "Starting Graphnosis server… (logs: $LOG)"
  GRAPHNOSIS_HTTP_UI=1 \
  GRAPHNOSIS_HTTP_UI_PORT="$PORT" \
  GRAPHNOSIS_HTTP_UI_TOKEN="$TOKEN" \
  GRAPHNOSIS_CORTEX="$CORTEX" \
  GRAPHNOSIS_PASSPHRASE="${GRAPHNOSIS_PASSPHRASE:-}" \
  nohup "$NODE_BIN" "$SIDECAR" >"$LOG" 2>&1 &
  # Wait up to ~30s for the UI to answer.
  for _ in $(seq 1 60); do
    if is_up; then break; fi
    sleep 0.5
  done
  if ! is_up; then
    echo "Server didn't come up in time — check $LOG for errors." >&2
    exit 1
  fi
fi

# ── Open the browser ─────────────────────────────────────────────────────────
case "$(uname -s)" in
  Darwin) open "$URL" >/dev/null 2>&1 || true ;;
  Linux)  xdg-open "$URL" >/dev/null 2>&1 || true ;;
esac
echo "Graphnosis is at: $URL"
echo "To stop it: pkill -f 'desktop-sidecar/dist/index.js'"
