#!/usr/bin/env bash
# Behaviour suite for scripts/pre-commit-guard.sh.
#
# The guard is a shell script, so it is tested by RUNNING it, never by reading
# it. Every case builds a throwaway git repo under $TMPDIR, stages something,
# runs the guard, and asserts the exit code.
#
# EVERY CASE ASSERTS A DIRECTION. A guard suite that only exercises the passing
# direction proves nothing: half the cases here must BLOCK (exit 1) and half
# must PASS (exit 0), and the PASS cases are what stop a fix from degenerating
# into "block everything".
#
# All needles used here are SYNTHETIC (they come from
# scripts/.sensitive-needles.example). This suite never reads the real
# scripts/.sensitive-needles.
#
# Run:   bash scripts/tests/pre-commit-guard.test.sh
# Mutate: GUARD=/path/to/mutant.sh bash scripts/tests/pre-commit-guard.test.sh
set -uo pipefail

SUITE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
GUARD="${GUARD:-$SUITE_DIR/../pre-commit-guard.sh}"
GUARD="$(cd -- "$(dirname -- "$GUARD")" && pwd -P)/$(basename -- "$GUARD")"

NEEDLE='Jane Placeholder'          # synthetic; see .sensitive-needles.example
NEEDLE_ORG='ExampleOrgName'        # synthetic
NEEDLE_DIACRITIC='Example Grünwald' # synthetic, listed WITH the diacritic

WORK="$(mktemp -d "${TMPDIR:-/tmp}/guard-suite.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
REPO="$WORK/repo"
OUT="$WORK/out.txt"

pass_n=0
fail_n=0
FAILED=()

# --- harness ---------------------------------------------------------------

fresh_repo() {
  rm -rf "$REPO"
  mkdir -p "$REPO/scripts"
  git -C "$REPO" init -q
  git -C "$REPO" config user.email guard-suite@example.invalid
  git -C "$REPO" config user.name  guard-suite
  git -C "$REPO" config commit.gpgsign false
  cp "$GUARD" "$REPO/scripts/pre-commit-guard.sh"
  chmod +x "$REPO/scripts/pre-commit-guard.sh"
  # Needle list with comments, blanks and a CRLF line — the parser must cope.
  {
    printf '# synthetic needles for the guard suite\r\n'
    printf '\n'
    printf '%s\r\n' "$NEEDLE"
    printf '%s\n' "$NEEDLE_ORG"
    printf '%s\n' "$NEEDLE_DIACRITIC"
  } > "$REPO/scripts/.sensitive-needles"
  # A baseline commit, so the index has a HEAD to diff against.
  printf 'seed\n' > "$REPO/seed.txt"
  git -C "$REPO" add seed.txt >/dev/null 2>&1
  git -C "$REPO" commit -qm seed >/dev/null 2>&1
}

stage() { git -C "$REPO" add -f -- "$@" >/dev/null 2>&1; }

write_at() { # write_at <relpath> <content...>
  local p="$REPO/$1"; shift
  mkdir -p "$(dirname -- "$p")"
  printf '%s\n' "$@" > "$p"
}

run_guard() {
  ( cd "$REPO" && ./scripts/pre-commit-guard.sh ) >"$OUT" 2>&1
  echo $?
}

expect() { # expect <0|1> <case name>
  local want="$1" name="$2" got
  got="$(run_guard)"
  if [[ "$got" == "$want" ]]; then
    pass_n=$((pass_n + 1))
    printf '  ok   [%s] %s\n' "$([[ $want == 1 ]] && echo BLOCK || echo PASS)" "$name"
  else
    fail_n=$((fail_n + 1))
    FAILED+=("$name (wanted exit $want, got $got)")
    printf '  FAIL [%s] %s -- wanted exit %s, got %s\n' \
      "$([[ $want == 1 ]] && echo BLOCK || echo PASS)" "$name" "$want" "$got"
    sed 's/^/         | /' "$OUT" | head -6
  fi
}

section() { printf '\n%s\n' "$1"; }

# ===========================================================================
section "config / fail-closed"
# ===========================================================================

fresh_repo
rm -f "$REPO/scripts/.sensitive-needles"
write_at "a.ts" 'const x = 1;'
stage a.ts
expect 1 "missing needle list refuses (fail closed)"

fresh_repo
{ printf '# only comments\n'; printf '\n'; } > "$REPO/scripts/.sensitive-needles"
write_at "a.ts" 'const x = 1;'
stage a.ts
expect 1 "needle list with no needles refuses (fail closed)"

fresh_repo
write_at "a.ts" "const owner = \"$NEEDLE\";"
stage a.ts
expect 1 "CRLF / comment / blank lines still yield a live needle"

fresh_repo
expect 0 "nothing staged passes"

# ===========================================================================
section "path blocks"
# ===========================================================================

for p in apps/desktop-sidecar/src/smoketest.ts \
         apps/desktop-sidecar/src/smoketest-brain.ts \
         apps/desktop-sidecar/src/smoketest-license.ts \
         apps/desktop-sidecar/dist/smoketest.js \
         apps/desktop-sidecar/dist/smoketest-brain.js \
         apps/desktop-sidecar/dist/smoketest-license.js; do
  fresh_repo
  write_at "$p" 'export const clean = 1;'
  stage "$p"
  expect 1 "smoketest artifact blocked: $p"
done

fresh_repo
write_at "apps/desktop-sidecar/src/smoketest-helpers.ts" 'export const clean = 1;'
stage apps/desktop-sidecar/src/smoketest-helpers.ts
expect 0 "smoketest-adjacent clean file is not blocked (control)"

fresh_repo
stage scripts/.sensitive-needles
expect 1 "the needle list itself can never be staged (git add -f)"

# ===========================================================================
section "content matching"
# ===========================================================================

fresh_repo
write_at "a.ts" "const owner = \"$NEEDLE\";"
stage a.ts
expect 1 "exact-case needle blocks"

fresh_repo
write_at "a.ts" "const owner = \"jane placeholder\";"
stage a.ts
expect 1 "case-folded needle blocks (grep -Fi)"

fresh_repo
write_at "a.ts" 'export const id = "q-exampleorgname-0042";'
stage a.ts
expect 1 "needle mangled inside a larger token blocks (substring)"

fresh_repo
write_at "a.ts" 'const owner = "Synthetic Person";'
stage a.ts
expect 0 "clean file passes"

fresh_repo
write_at "a.ts" 'const owner = "Example Grunwald";'
stage a.ts
expect 0 "diacritic variant is NOT folded (documented limitation)"

fresh_repo
write_at "a.ts" "const owner = \"$NEEDLE_DIACRITIC\";"
stage a.ts
expect 1 "needle with a diacritic blocks when listed with it (grep -a, high bytes)"

# ===========================================================================
section "BYPASS (a): the index is what gets committed, not the worktree"
# ===========================================================================

fresh_repo
write_at "leak.ts" "const owner = \"$NEEDLE\";"
stage leak.ts
write_at "leak.ts" 'const owner = "Synthetic Person";'   # clean the worktree copy
expect 1 "staged-then-cleaned worktree still blocks (git add -p then edit)"

fresh_repo
write_at "leak.ts" "const owner = \"$NEEDLE\";"
stage leak.ts
rm -f "$REPO/leak.ts"                                     # delete the worktree copy
expect 1 "staged-then-deleted worktree still blocks"

fresh_repo
write_at "leak.ts" 'const owner = "Synthetic Person";'
stage leak.ts
write_at "leak.ts" "const owner = \"$NEEDLE\";"           # dirty, but UNSTAGED
expect 0 "unstaged worktree needle does not block (the index is clean)"

fresh_repo
write_at "old.ts" "const owner = \"$NEEDLE\";"
git -C "$REPO" add -f old.ts >/dev/null 2>&1
git -C "$REPO" commit -qm "historical leak" >/dev/null 2>&1
git -C "$REPO" rm -q old.ts >/dev/null 2>&1
expect 0 "staged DELETION of a needle-bearing file passes (removal is not a leak)"

fresh_repo
write_at "src/before.ts" "const owner = \"$NEEDLE\";"
git -C "$REPO" add -f src/before.ts >/dev/null 2>&1
git -C "$REPO" commit -qm "pre-existing" >/dev/null 2>&1
git -C "$REPO" mv src/before.ts src/after.ts >/dev/null 2>&1
expect 1 "staged RENAME of a needle-bearing file blocks at the new path"

fresh_repo
ln -s "/var/tmp/$NEEDLE/x" "$REPO/link"
stage link
expect 1 "symlink whose target path carries the needle blocks (blob is the target)"

# ===========================================================================
section "BYPASS (b): deny by default — every textual type is scanned"
# ===========================================================================

# The 12 extensions measured as PASSING under the extension allowlist, plus .ts
# (the one it did cover) as the positive control for this block.
for ext in ts astro patch service command bat lock sha256 mdown rst tex log gll; do
  fresh_repo
  write_at "leak.$ext" "owner = \"$NEEDLE\""
  stage "leak.$ext"
  expect 1 "extension .$ext is scanned"
done

fresh_repo
write_at "leak.zzz-never-seen-2026" "owner = \"$NEEDLE\""
stage leak.zzz-never-seen-2026
expect 1 "a brand-new unknown extension is protected by DEFAULT"

for p in Dockerfile LICENSE .githooks/pre-commit .myconfig deploy/app.conf README.md tests/_fixtures.ts; do
  fresh_repo
  write_at "$p" "owner = \"$NEEDLE\""
  stage "$p"
  expect 1 "extension-less / off-allowlist path is scanned: $p"
done

fresh_repo
write_at "docs/notes.md" 'All names here are synthetic.'
stage docs/notes.md
expect 0 "clean off-allowlist path passes"

# ===========================================================================
section "skip list and binary detection"
# ===========================================================================

fresh_repo
{ printf 'PNGX'; head -c 8 /dev/zero; printf '%s' "$NEEDLE"; head -c 8 /dev/zero; } > "$REPO/logo.png"
stage logo.png
expect 0 "binary blob is skipped without error"
if command grep -aq 'REFUSING\|BLOCKED' "$OUT"; then
  fail_n=$((fail_n + 1)); FAILED+=("binary skip emitted an error line")
  printf '  FAIL [PASS] binary skip must be silent, got:\n'; sed 's/^/         | /' "$OUT"
else
  pass_n=$((pass_n + 1)); printf '  ok   [PASS] binary skip is silent\n'
fi

fresh_repo
{ printf 'no-extension-binary'; head -c 8 /dev/zero; printf '%s' "$NEEDLE"; } > "$REPO/blobfile"
stage blobfile
expect 0 "extension-less binary is skipped on CONTENT, not on its name"

fresh_repo
write_at "pnpm-lock.yaml" "resolution: \"$NEEDLE\""
stage pnpm-lock.yaml
expect 0 "skip-list basename is exempt (deliberate, documented)"

fresh_repo
write_at "leak.lock" "owner = \"$NEEDLE\""
stage leak.lock
expect 1 "skip list is EXACT-BASENAME, not a glob: leak.lock is still scanned"

fresh_repo
write_at "vendor/not-pnpm-lock.yaml" "owner = \"$NEEDLE\""
stage vendor/not-pnpm-lock.yaml
expect 1 "a name merely containing a skip entry is still scanned"

fresh_repo
write_at "packages/core/pnpm-lock.yaml" "resolution: \"$NEEDLE\""
stage packages/core/pnpm-lock.yaml
expect 0 "skip-list basename is exempt in a subdirectory too"

# ===========================================================================
section "hostile path names"
# ===========================================================================
# `git cat-file blob ":0:$path"` puts the path inside a revision expression, so
# a path containing ':' or '#' is the obvious way this rewrite could regress
# into a silent skip.

fresh_repo
write_at "dir with spaces/a b:c#d'e.ts" "owner = \"$NEEDLE\""
stage "dir with spaces/a b:c#d'e.ts"
expect 1 "path with space, colon, hash and quote is scanned"

fresh_repo
write_at "café-notes.md" "owner = \"$NEEDLE\""
stage "café-notes.md"
expect 1 "non-ASCII path is scanned"

fresh_repo
write_at "--" "owner = \"$NEEDLE\""
stage "--"
expect 1 "a file literally named -- is scanned"

# ===========================================================================
section "unreadable index entries"
# ===========================================================================

fresh_repo
# An index entry whose blob object does not exist. The guard cannot see what is
# being committed, so it must REFUSE — the same fail-closed rule as a missing
# needle list. Silently skipping the path is how a guard produces a green run
# while blind.
git -C "$REPO" update-index --add \
  --cacheinfo 100644,0000000000000000000000000000000000000001,ghost.ts >/dev/null 2>&1
expect 1 "unreadable staged blob fails CLOSED"
if command grep -aq 'REFUSING' "$OUT"; then
  pass_n=$((pass_n + 1)); printf '  ok   [BLOCK] unreadable blob says REFUSING\n'
else
  fail_n=$((fail_n + 1)); FAILED+=("unreadable blob did not print REFUSING")
  printf '  FAIL [BLOCK] unreadable blob should print REFUSING, got:\n'; sed 's/^/         | /' "$OUT"
fi

fresh_repo
# A submodule gitlink is a commit id, not file content: nothing to scan, and it
# must NOT be confused with the unreadable-blob case above.
SUB_SHA="$(git -C "$REPO" rev-parse HEAD)"
git -C "$REPO" update-index --add --cacheinfo "160000,$SUB_SHA,vendor/sub" >/dev/null 2>&1
expect 0 "submodule gitlink is skipped, not treated as unreadable"

# ===========================================================================
section "multi-file"
# ===========================================================================

fresh_repo
write_at "a.ts" 'const ok = 1;'
write_at "b.rst" "owner = \"$NEEDLE\""
write_at "c.md" 'clean'
stage a.ts b.rst c.md
expect 1 "one dirty file among clean ones blocks the whole commit"

fresh_repo
write_at "a.ts" 'const ok = 1;'
write_at "b.rst" 'clean'
write_at "c.md" 'clean'
stage a.ts b.rst c.md
expect 0 "all-clean multi-file commit passes"

# ===========================================================================
printf '\n%d passed, %d failed\n' "$pass_n" "$fail_n"
if (( fail_n )); then
  printf 'failed cases:\n'
  for f in "${FAILED[@]}"; do printf '  - %s\n' "$f"; done
  exit 1
fi
exit 0
