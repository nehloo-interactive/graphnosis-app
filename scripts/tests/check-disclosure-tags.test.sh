#!/usr/bin/env bash
# Behaviour suite for scripts/check-disclosure-tags.sh.
#
# The check is a shell script, so it is tested by RUNNING it, never by reading
# it. Every case builds a throwaway git repo under $TMPDIR, puts files in a
# specific git STATE (ignored / visible / staged / tracked), runs the check and
# asserts the exit code.
#
# EVERY CASE ASSERTS A DIRECTION. Half must REFUSE and half must PASS: a suite
# that only exercises the refusing direction is satisfied by `exit 1`, and the
# passing cases are the ones that stop this check from degenerating into
# "refuse everything", which is how a control gets switched off for real.
#
# EXIT CODES UNDER TEST
#   0 clean - 1 REFUSED - 2 self-test void - 3 EXPOSED - 4 missing prerequisite
#
# Run:    bash scripts/tests/check-disclosure-tags.test.sh
# Mutate: CHECK=/path/to/mutant.sh bash scripts/tests/check-disclosure-tags.test.sh
set -uo pipefail

SUITE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
CHECK="${CHECK:-$SUITE_DIR/../check-disclosure-tags.sh}"
CHECK="$(cd -- "$(dirname -- "$CHECK")" && pwd -P)/$(basename -- "$CHECK")"

# The tag key is SPLIT so that this suite file cannot match the very regex it
# tests. scripts/check-disclosure-tags.sh scans every file git can see, and
# this file lives in scripts/ - a literal tag here would make the real repo's
# own run report a phantom held file. Do not "tidy" this into one string.
K='@''disclosure'
TAG_C="// $K: (c) live-on-shipped - synthetic"
TAG_B="// $K: (b) fix-not-adopted - synthetic"
TAG_A="// $K: (a) publishable - synthetic"
TAG_SRC="// $K-src: 2.59a S5.2 - synthetic companion line, NOT a tag"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/disclosure-suite.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
REPO="$WORK/repo"
OUT="$WORK/out.txt"

pass_n=0; fail_n=0; FAILED=()

# --- harness ---------------------------------------------------------------

write_at() { # write_at <relpath> <line...>
  local p="$REPO/$1"; shift
  mkdir -p "$(dirname -- "$p")"
  printf '%s\n' "$@" > "$p"
}

stage() { git -C "$REPO" add -f -- "$@" >/dev/null 2>&1; }

fresh_repo() {
  rm -rf "$REPO"
  mkdir -p "$REPO/scripts"
  git -C "$REPO" init -q
  git -C "$REPO" config user.email disclosure-suite@example.invalid
  git -C "$REPO" config user.name  disclosure-suite
  git -C "$REPO" config commit.gpgsign false
  cp "$CHECK" "$REPO/scripts/check-disclosure-tags.sh"
  chmod +x "$REPO/scripts/check-disclosure-tags.sh"

  # 20 synthetic held files, all correctly tagged and all IGNORED, so the
  # baseline repo is clean and each case below changes exactly one thing.
  printf 'held/\n' > "$REPO/.gitignore"
  mkdir -p "$REPO/held"
  : > "$REPO/scripts/disclosure-held.txt"
  local i n
  for i in $(seq -w 1 20); do
    printf '%s\n/**\n * synthetic held suite %s\n */\n' "$TAG_C" "$i" > "$REPO/held/h$i.mjs"
    printf 'held/h%s.mjs\n' "$i" >> "$REPO/scripts/disclosure-held.txt"
  done

  # A 5-entry allowlist naming files that exist and are class (a).
  : > "$REPO/scripts/tests-allowlist.txt"
  for n in a1 a2 a3 a4 a5; do
    printf '%s\n/**\n * synthetic publishable suite %s\n */\n' "$TAG_A" "$n" > "$REPO/pub-$n.ts"
    printf 'pub-%s.ts\n' "$n" >> "$REPO/scripts/tests-allowlist.txt"
  done

  write_at "seed.ts" 'export const marker = 1;'
  git -C "$REPO" add .gitignore seed.ts >/dev/null 2>&1
  git -C "$REPO" commit -qm seed >/dev/null 2>&1
}

run_check() { ( cd "$REPO" && ./scripts/check-disclosure-tags.sh ) >"$OUT" 2>&1; echo $?; }

label() { case "$1" in 0) echo PASS;; 1) echo REFUSE;; 2) echo VOID;; 3) echo EXPOSE;; 4) echo PREREQ;; *) echo "$1";; esac; }

expect() { # expect <want-exit> <case name>
  local want="$1" name="$2" got
  got="$(run_check)"
  if [ "$got" = "$want" ]; then
    pass_n=$((pass_n + 1))
    printf '  ok   [%-6s] %s\n' "$(label "$want")" "$name"
  else
    fail_n=$((fail_n + 1))
    FAILED+=("$name (wanted exit $want, got $got)")
    printf '  FAIL [%-6s] %s -- wanted exit %s, got %s\n' "$(label "$want")" "$name" "$want" "$got"
    sed 's/^/         | /' "$OUT" | head -8
  fi
}

section() { printf '\n%s\n' "$1"; }

# ===========================================================================
section "baseline"
# ===========================================================================

fresh_repo
expect 0 "clean repo: held files present, tagged and ignored"

# ===========================================================================
section "S. self-test / prerequisites (fail closed)"
# ===========================================================================

fresh_repo
rm -f "$REPO/scripts/disclosure-held.txt"
expect 4 "missing held list is a missing prerequisite, not a pass"

fresh_repo
rm -f "$REPO/scripts/tests-allowlist.txt"
expect 4 "missing 2.62c allowlist is a missing prerequisite, not a pass"

fresh_repo
printf 'held/h01.mjs\n' > "$REPO/scripts/disclosure-held.txt"
expect 2 "a held list that parsed to 1 entry is VOID, not clean"

fresh_repo
{ printf '# only comments\n'; printf '\n'; } > "$REPO/scripts/disclosure-held.txt"
expect 2 "an all-comment held list is VOID, not clean"

# ===========================================================================
section "H. integrity - the header is not the only witness"
# ===========================================================================

fresh_repo
rm -f "$REPO/held/h07.mjs"
expect 1 "a held file that vanished is refused"

fresh_repo
grep -v -- "$K" "$REPO/held/h07.mjs" > "$REPO/held/h07.tmp" && mv "$REPO/held/h07.tmp" "$REPO/held/h07.mjs"
expect 1 "STRIPPING the header does not declassify the file"

fresh_repo
printf '%s\n/**\n * downgraded\n */\n' "$TAG_A" > "$REPO/held/h07.mjs"
expect 1 "DOWNGRADING a held file's tag to (a) is refused"

fresh_repo
{ for i in $(seq 1 70); do printf '// filler %s\n' "$i"; done; printf '%s\n' "$TAG_C"; } > "$REPO/held/h07.mjs"
expect 1 "a tag pushed past the header window reads as untagged"

# ===========================================================================
section "R. refusal - nothing (b)/(c) may be tracked  [THE CORE CASE]"
# ===========================================================================

fresh_repo
write_at "notes/scratch.ts" "$TAG_C" "$TAG_SRC" 'export const x = 1;'
stage notes/scratch.ts
expect 1 "a (c)-tagged scratch file cannot be staged"

fresh_repo
write_at "notes/scratch.ts" "$TAG_A" "$TAG_SRC" 'export const x = 1;'
stage notes/scratch.ts
expect 0 "the SAME file retagged (a) stages cleanly"

fresh_repo
write_at "notes/scratch.ts" "$TAG_B" 'export const x = 1;'
stage notes/scratch.ts
expect 1 "a (b)-tagged scratch file cannot be staged either"

fresh_repo
write_at "notes/scratch.ts" "$TAG_C" 'export const x = 1;'
stage notes/scratch.ts
git -C "$REPO" commit -qm tracked >/dev/null 2>&1
expect 1 "already-TRACKED (c) content is refused on every later run, not just at add time"

# The index-vs-worktree miss that this repo's pre-commit guard already shipped
# a fix for. Stage the tagged file, then clean the WORKTREE copy: a worktree
# scan sees nothing while the staged blob still carries the tag.
fresh_repo
write_at "notes/scratch.ts" "$TAG_C" 'export const x = 1;'
stage notes/scratch.ts
write_at "notes/scratch.ts" 'export const x = 1;'
expect 1 "stage-then-clean-the-worktree still refuses (the INDEX is scanned)"

# ===========================================================================
section "R. decoys - things that look like a tag and are not"
# ===========================================================================

fresh_repo
write_at "notes/scratch.ts" "$TAG_SRC" 'export const x = 1;'
stage notes/scratch.ts
expect 0 "the -src companion line alone is not a classification"

fresh_repo
write_at "notes/scratch.ts" "assert(t.includes(\"$K: (c)\"));" 'export const x = 1;'
stage notes/scratch.ts
expect 0 "a mid-line prose mention is not a classification"

fresh_repo
{ for i in $(seq 1 70); do printf '// filler %s\n' "$i"; done; printf '%s\n' "$TAG_C"; } > "$REPO/notes-scratch.ts"
stage notes-scratch.ts
expect 0 "outside a classified lane, a tag below the window is not a tag (window is real)"

# ===========================================================================
section "N. unclassified - a new suite in a classified lane must declare"
# ===========================================================================

fresh_repo
write_at "apps/desktop-sidecar/tests/brand-new.test.mjs" '/** no classification */'
stage apps/desktop-sidecar/tests/brand-new.test.mjs
expect 1 "an untagged NEW sidecar suite cannot be staged"

fresh_repo
write_at "apps/desktop-sidecar/tests/brand-new.test.mjs" '/** no classification */'
expect 3 "an untagged NEW sidecar suite that is merely visible is EXPOSED, not clean"

fresh_repo
write_at "tests/desktop/brand-new.test.ts" '/** no classification */'
stage tests/desktop/brand-new.test.ts
expect 1 "an untagged NEW desktop-lane suite cannot be staged"

fresh_repo
write_at "apps/desktop-sidecar/tests/brand-new.test.mjs" "$TAG_A" '/** classified publishable */'
stage apps/desktop-sidecar/tests/brand-new.test.mjs
expect 0 "a NEW sidecar suite tagged (a) stages cleanly"

fresh_repo
write_at "apps/desktop-sidecar/tests/fixtures.json" '{"unclassified": true}'
stage apps/desktop-sidecar/tests/fixtures.json
expect 0 "the lane rule is scoped to .mjs/.ts, so a data file is not refused (control)"

# ===========================================================================
section "C. contradiction with the 2.62c allowlist"
# ===========================================================================

fresh_repo
printf 'held/h01.mjs\n' >> "$REPO/scripts/tests-allowlist.txt"
expect 1 "a path on BOTH the allowlist and the held list is a contradiction"

fresh_repo
printf '%s\n/**\n * relabelled\n */\n' "$TAG_C" > "$REPO/pub-a3.ts"
expect 1 "an allowlisted (publishable) path carrying a (c) tag is a contradiction"

fresh_repo
printf '%s\n/**\n * still publishable\n */\n' "$TAG_A" > "$REPO/pub-a3.ts"
expect 0 "an allowlisted path carrying an (a) tag is consistent (control)"

# ===========================================================================
section "E. exposure - visible but not tracked"
# ===========================================================================

fresh_repo
write_at "notes/scratch.ts" "$TAG_C" 'export const x = 1;'
expect 3 "a (c)-tagged file that is visible but unstaged is EXPOSED, not clean"

fresh_repo
write_at "notes/scratch.ts" "$TAG_C" 'export const x = 1;'
printf 'notes/\n' >> "$REPO/.gitignore"
expect 0 "gitignoring the same file closes the exposure (the remedy actually works)"

fresh_repo
write_at "notes/scratch.ts" "$TAG_C" 'export const x = 1;'
stage notes/scratch.ts
expect 1 "staged beats visible: exit 1 wins over exit 3 (precedence)"

# ===========================================================================
printf '\n%d passed, %d failed\n' "$pass_n" "$fail_n"
if [ "$fail_n" -ne 0 ]; then
  printf 'failed cases:\n'
  for f in "${FAILED[@]}"; do printf '  - %s\n' "$f"; done
  exit 1
fi
exit 0
