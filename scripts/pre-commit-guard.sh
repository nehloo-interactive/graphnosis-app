#!/usr/bin/env bash
# Fast staged-file guard: block smoketest sources; warn on known fixture strings in app source.
set -euo pipefail

blocked=0
warned=0

SENSITIVE_FIXTURES=(
  'Diana Gini'
  'Virginia Linul'
  'UnpublishedRomania'
  'Anca Mizumschi'
  'Nelu Lazar'
)

while IFS= read -r -d '' path; do
  [[ -z "$path" ]] && continue

  case "$path" in
    apps/desktop-sidecar/src/smoketest.ts|\
    apps/desktop-sidecar/src/smoketest-brain.ts|\
    apps/desktop-sidecar/src/smoketest-license.ts|\
    apps/desktop-sidecar/dist/smoketest.js|\
    apps/desktop-sidecar/dist/smoketest-brain.js|\
    apps/desktop-sidecar/dist/smoketest-license.js)
      echo "pre-commit-guard: BLOCKED — do not commit smoketest artifacts: $path" >&2
      echo "  Smoke tests are local-only (see CLAUDE.md). Keep them gitignored." >&2
      blocked=1
      ;;
  esac

  case "$path" in
    apps/*|packages/*)
      if [[ -f "$path" ]] && [[ "$path" =~ \.(ts|tsx|js|jsx|mjs|cjs|rs|md)$ ]]; then
        for needle in "${SENSITIVE_FIXTURES[@]}"; do
          if grep -Fq "$needle" "$path" 2>/dev/null; then
            echo "pre-commit-guard: WARNING — staged file may contain personal fixture data: $path (matched: $needle)" >&2
            warned=1
          fi
        done
      fi
      ;;
  esac
done < <(git diff --cached --name-only -z --diff-filter=ACMR)

if (( blocked )); then
  exit 1
fi

if (( warned )); then
  echo "pre-commit-guard: review warnings above before committing (smoketest/PII fixtures belong local-only)." >&2
fi

exit 0
