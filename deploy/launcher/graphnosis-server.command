#!/bin/bash
# macOS double-clickable wrapper — Finder runs .command files in Terminal.
# Delegates to the shared launcher next to it.
exec "$(cd "$(dirname "$0")" && pwd)/graphnosis-server.sh" "$@"
