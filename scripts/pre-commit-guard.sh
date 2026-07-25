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
  'Black Sea Vallachs'
  "world's carols"
  'World'"'"'s Carols'
  'Carmel International'
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
      # Extensions deliberately broad: fixtures and eval sets live in .json,
      # and UI comments in .css — both slipped real names past the earlier
      # ts/js-only filter. Matching is case-INSENSITIVE because the same name
      # appears folded ("unpublishedromania") in query fixtures.
      if [[ -f "$path" ]] && [[ "$path" =~ \.(ts|tsx|js|jsx|mjs|cjs|rs|md|json|css|html|ya?ml|txt)$ ]]; then
        for needle in "${SENSITIVE_FIXTURES[@]}"; do
          if grep -Fiq "$needle" "$path" 2>/dev/null; then
            echo "pre-commit-guard: BLOCKED — staged file contains personal fixture data: $path (matched: $needle)" >&2
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
  echo "pre-commit-guard: replace the matched fixture(s) with synthetic placeholders — this repo is PUBLIC." >&2
  echo "  Real personal names/projects must not reach app source, docs, or tests." >&2
  echo "  Deliberate exception: git commit --no-verify" >&2
  exit 1
fi

exit 0
