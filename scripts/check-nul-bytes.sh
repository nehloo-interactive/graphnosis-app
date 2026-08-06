#!/usr/bin/env bash
# scripts/check-nul-bytes.sh — refuse a raw NUL byte (0x00) in a source file.
#
# THE PROBLEM THIS SOLVES
# -----------------------
# A single 0x00 anywhere in a file makes grep(1) classify the WHOLE file as
# binary. From then on grep prints no matches and EXITS 1 — the same output,
# byte for byte, that it produces when the symbol genuinely is not there:
#
#     $ grep -c restoreLkg apps/desktop-sidecar/src/host.ts
#     $ echo $?
#     1
#
# `restoreLkg` is defined in that file, twice. "Not found" and "I refused to
# read this file" are INDISTINGUISHABLE, and nothing errors. That is the worst
# shape a failure can take: a silent false negative in the tool everyone uses
# to decide whether a thing exists. Agents working this repo have already
# concluded that a live capability did not exist because of exactly this.
#
# It does not show up in review, because it breaks nothing a compiler checks.
# All three sites this check was written against typecheck at 0 errors: the
# byte sits inside a string literal. ripgrep reads such files fine, so whoever
# is using `rg` never sees the discrepancy and cannot reproduce the report.
#
# THE REMEDY IS NOT "DELETE THE BYTE"
# -----------------------------------
# In every case found so far the NUL was DELIBERATE and load-bearing — a
# separator chosen precisely because it cannot occur in the data around it:
#
#     private static readonly SEP = '<0x00>';           // on-disk record separator
#     `${graphId}<0x00>verify`                          // collision-proof scratch id
#     corpus.map(f => f.lower).join('\n<0x00>\n')       // corpus boundary sentinel
#
# Deleting the byte CHANGES THE STRING'S VALUE and therefore the behavior. For
# the first one it would silently turn the separator into the EMPTY STRING and
# make `split(SEP)` explode a record into single characters.
#
# Write the byte as a SOURCE ESCAPE instead:
#
#     '\u0000'     in place of a literal 0x00 in the file
#
# The runtime string is byte-for-byte identical. The file on disk contains no
# NUL, so grep reads it as text again. That is the fix this check asks for, and
# it is why the check can always be satisfied without changing a string value.
#
# WHY THE DETECTION IS EXACT AND NOT A HEURISTIC
# ----------------------------------------------
# `grep -I`, `file(1)` and git's own "is this blob binary" test all decide from
# a LEADING WINDOW of the file. A NUL past that window is missed. Building this
# check on any of them would reproduce the exact false-negative class it exists
# to eliminate. So every candidate file is compared against itself with its NUL
# bytes stripped:  tr -d '\000' < f | cmp -s - f. Whole file, no window, no
# heuristic. The self-test proves the comparison is live.
#
# SCOPE
# -----
# Source extensions ONLY — SRC_PATHSPECS below is the single source of truth,
# and the find filter, the git pathspecs and the self-test regex are all
# derived from it so they cannot drift apart. Real binary assets (.png .ico
# .icns .woff .ttf .jpg .pdf .gai .bin) are never opened, so this check cannot
# false-positive on them. That is deliberate: a guard that flags an icon is a
# guard that gets commented out by the first person it annoys.
#
# node_modules / dist / build / target / .git / .claude are excluded by
# construction in the default modes (git never lists them) and by explicit
# prune in --all.
#
# SECTIONS
#   S. SELF-TEST  - detector and offset locator proven live against controls.
#   A. TRACKED    - worktree content of every tracked source file.
#   B. VISIBLE    - untracked-but-not-ignored source files (pre-`git add`).
#   C. STAGED     - the INDEX BLOB of every staged source file. Not the same
#                   as A: stage a file, then clean the worktree copy, and a
#                   worktree-only scan reports clean while the staged blob is
#                   still bad. Same reasoning as check-disclosure-tags.sh.
#   D. IGNORED    - only with --all. Gitignored source lanes (tests/lint/, the
#                   local-only suites). They are never published, so they are
#                   not a disclosure problem — but they are read with grep by
#                   the same people every day, so they are exactly as blinding.
#
# EXIT CODES
#   0  clean
#   1  a NUL byte was found in a source file
#   2  self-test failed — this check's own machinery is broken, result is VOID
#   4  usage / missing prerequisite
#
# Run standalone:   bash scripts/check-nul-bytes.sh [--all]
#           or:     pnpm check:nul-bytes   /   pnpm check:nul-bytes:all
#
# NOTE ON WIRING: as of this writing the scripts/check-*.sh family has NO
# automated caller. .githooks/pre-commit runs scripts/pre-commit-guard.sh and
# nothing else, and no GitHub workflow invokes any check-*.sh. Wiring this into
# pre-commit-guard.sh additionally requires copying it into `fresh_repo` in
# scripts/tests/pre-commit-guard.test.sh — that suite copies ONLY the guard
# into its throwaway repos, so a bare sibling call fails every case closed.

set -o pipefail

# Byte collation, so every sort/grep pairing below is consistent.
export LC_ALL=C

PROG="${0##*/}"

ALL=0
case "${1:-}" in
  --all) ALL=1 ;;
  -h|--help)
    echo "usage: $PROG [--all]"
    echo "  (default) scan tracked, visible-untracked and staged source files"
    echo "  --all     additionally scan gitignored source lanes in the worktree"
    exit 0 ;;
  "") ;;
  *) echo "$PROG: unknown argument: $1 (try --help)" >&2; exit 4 ;;
esac

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "$PROG: not a git repo" >&2; exit 4; }
cd "$ROOT" || exit 4

# --- THE single source of truth for "what counts as a source file" ----------
# Anything not listed here is NEVER READ, which is what keeps binary assets
# out of the blast radius.
SRC_PATHSPECS=(
  '*.ts' '*.tsx' '*.mts' '*.cts' '*.js' '*.jsx' '*.mjs' '*.cjs'
  '*.json' '*.jsonc' '*.css' '*.scss' '*.html' '*.htm' '*.md' '*.mdx'
  '*.sh' '*.bash' '*.zsh' '*.yml' '*.yaml' '*.toml' '*.rs' '*.swift'
  '*.py' '*.sql' '*.xml' '*.svg' '*.txt'
)

# DERIVED, never hand-maintained: the same list as `find -name` alternation …
FIND_NAME_ARGS=()
for _g in "${SRC_PATHSPECS[@]}"; do FIND_NAME_ARGS+=( -o -name "$_g" ); done
FIND_NAME_ARGS=( "${FIND_NAME_ARGS[@]:1}" )      # drop the leading -o

# … and as an ERE over a filename, used only by the self-test.
SRC_EXT_RE="\.($(printf '%s\n' "${SRC_PATHSPECS[@]}" | sed 's/^\*\.//' | paste -sd'|' -))\$"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/check-nul-bytes.XXXXXX")" || { echo "$PROG: mktemp failed" >&2; exit 4; }
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# ---------------------------------------------------------------------------
# has_nul <file>  -> 0 if the file contains at least one 0x00, else 1.
#
# Whole-file, exact. `cmp -s` compares the NUL-stripped stream against the
# original; they differ if and only if a NUL was removed.
# ---------------------------------------------------------------------------
has_nul() {
  tr -d '\000' < "$1" | cmp -s - "$1" && return 1
  return 0
}

# ---------------------------------------------------------------------------
# first_nul_offset <file>  -> byte offset of the first 0x00, on stdout.
#
# Binary search on `head -c`. POSIX only: macOS od has no -w, and awk dialects
# disagree about what a NUL inside a record does, so neither is trusted here.
# ~19 probes for a 500 KB file, and it only ever runs on a file already known
# to be bad, so the cost is irrelevant.
#
# Invariant: prefix [0,lo) contains no NUL; prefix [0,hi) contains one.
# ---------------------------------------------------------------------------
first_nul_offset() {
  local f="$1" size lo hi mid raw stripped
  size="$(wc -c < "$f" | tr -d ' ')"
  lo=0; hi="$size"
  while [ $((hi - lo)) -gt 1 ]; do
    mid=$(( (lo + hi) / 2 ))
    raw="$(head -c "$mid" -- "$f" | wc -c | tr -d ' ')"
    stripped="$(head -c "$mid" -- "$f" | tr -d '\000' | wc -c | tr -d ' ')"
    if [ "$raw" = "$stripped" ]; then lo="$mid"; else hi="$mid"; fi
  done
  echo $(( hi - 1 ))
}

# line_col <file> <offset> -> "<line> <column>"  (1-based line, 0-based column)
line_col() {
  local f="$1" off="$2" nl col
  nl="$(head -c "$off" -- "$f" | wc -l | tr -d ' ')"
  col="$(head -c "$off" -- "$f" | tail -1 | wc -c | tr -d ' ')"
  echo "$((nl + 1)) $col"
}

# report_hit <path-to-read> <path-to-print>
report_hit() {
  local off lc
  off="$(first_nul_offset "$1")"
  lc="$(line_col "$1" "$off")"
  printf '  %s\n' "$2" >&2
  printf '      first NUL at byte offset %s (line %s, column %s)\n' "$off" "${lc% *}" "${lc#* }" >&2
}

# ===========================================================================
# S. SELF-TEST — every clean negative below must be a CONTROLLED negative.
# ===========================================================================
st_fail() { echo "$PROG: SELF-TEST FAILED — $1" >&2; echo "$PROG: this run's result is VOID." >&2; exit 2; }

CTL="$WORK/ctl"; mkdir -p "$CTL"
# pos: a NUL at a KNOWN offset. "abcde" is 5 bytes, so the NUL is at 5.
printf 'abcde\000fghij' > "$CTL/pos.ts"
# neg-escape: the SIX CHARACTERS \u0000 , i.e. the remedy this check asks for.
# It must NOT be flagged, or the check would forbid its own fix.
printf 'const SEP = %s\\u0000%s;\n' "'" "'" > "$CTL/neg-escape.ts"
# neg-high: multi-byte UTF-8 but no NUL. Must not be flagged — this is the case
# a naive "does it look binary" heuristic gets wrong in the other direction.
printf 'const s = "caf\303\251 \342\200\224 \360\237\247\240";\n' > "$CTL/neg-high.ts"
# asset: a NUL-bearing file with a BINARY extension. Proves SCOPING, not
# detection — it must never be reached, because .png is not a source extension.
printf '\211PNG\r\n\032\n\000\000\000\015IHDR' > "$CTL/asset.png"

has_nul "$CTL/pos.ts"        || st_fail "detector did NOT flag the control file that contains a NUL."
has_nul "$CTL/neg-escape.ts" && st_fail "detector flagged the '\\u0000' ESCAPE control. It must match BYTES, not source text."
has_nul "$CTL/neg-high.ts"   && st_fail "detector flagged a NUL-free file containing multi-byte UTF-8."
has_nul "$CTL/asset.png"     || st_fail "control asset.png contains no NUL; the scoping control is void."

# The locator must report the TRUE offset. One hardwired to 0 would let every
# message below name the wrong place while still looking like it works.
got_off="$(first_nul_offset "$CTL/pos.ts")"
[ "$got_off" = "5" ] || st_fail "offset locator returned '$got_off' for a control whose NUL is at byte 5."
got_lc="$(line_col "$CTL/pos.ts" 5)"
[ "$got_lc" = "1 5" ] || st_fail "line/column locator returned '$got_lc' for the control (expected '1 5')."

# The derived extension filter must exclude binary assets and admit sources.
if printf '%s\n' 'icon.png' 'a/b/logo.icns' 'f.woff2' 'x.ttf' 'y.ico' 'z.jpg' 'w.pdf' 'v.gai' 'u.bin' \
     | grep -a -q -E "$SRC_EXT_RE"; then
  st_fail "the derived source-extension regex MATCHES a binary asset name. Scoping is broken."
fi
n_ctl_src="$(printf '%s\n' 'a.ts' 'b/c.mjs' 'd.json' 'e.sh' 'f.yml' 'g.md' | grep -a -c -E "$SRC_EXT_RE")"
[ "$n_ctl_src" = "6" ] || st_fail "the derived source-extension regex matched only $n_ctl_src/6 source controls."

fail=0
n_scanned=0

# ===========================================================================
# A / B — worktree content.
#
# NOTE: these loops read from PROCESS SUBSTITUTION, never from a pipe. A
# `git ls-files | while ...` puts the loop in a subshell, so `fail=1` set
# inside it is discarded and the check reports OK on a dirty tree. That is the
# same silent-false-negative class this whole script exists to prevent.
# ===========================================================================
scan_paths() {                        # scan_paths <label> ; NUL-separated on fd 0
  local label="$1" f hits=0
  while IFS= read -r -d '' f; do
    [ -f "$f" ] || continue
    n_scanned=$((n_scanned + 1))
    if [ ! -r "$f" ]; then
      # Fail closed: a file we cannot read is not a file we can call clean.
      echo "$PROG: FAIL ($label) — unreadable source file: $f" >&2
      fail=1; continue
    fi
    if has_nul "$f"; then
      [ "$hits" -eq 0 ] && echo "$PROG: FAIL ($label) — raw NUL byte (0x00) in source file(s):" >&2
      hits=$((hits + 1)); fail=1
      report_hit "$f" "$f"
    fi
  done
}

# --- A. TRACKED -------------------------------------------------------------
scan_paths "A/TRACKED" < <(git ls-files -z -- "${SRC_PATHSPECS[@]}")

# --- B. VISIBLE (untracked, not ignored) ------------------------------------
scan_paths "B/VISIBLE" < <(git ls-files --others --exclude-standard -z -- "${SRC_PATHSPECS[@]}")

# --- C. STAGED (index blobs, not the worktree) ------------------------------
staged_hits=0
while IFS= read -r -d '' p; do
  [ -n "$p" ] || continue
  BLOB="$WORK/blob"
  if ! git cat-file blob ":0:$p" > "$BLOB" 2>/dev/null; then
    mode="$(git ls-files --stage -- "$p" 2>/dev/null | awk 'NR==1{print $1}')"
    [ "$mode" = "160000" ] && continue          # submodule gitlink: no content
    echo "$PROG: FAIL (C/STAGED) — cannot read staged content for: $p" >&2
    fail=1; continue
  fi
  n_scanned=$((n_scanned + 1))
  if has_nul "$BLOB"; then
    if [ "$staged_hits" -eq 0 ]; then
      echo "$PROG: FAIL (C/STAGED) — raw NUL byte (0x00) in STAGED content:" >&2
      echo "$PROG: (the index blob — that is what a commit would publish)" >&2
    fi
    staged_hits=$((staged_hits + 1)); fail=1
    report_hit "$BLOB" "$p  [staged blob]"
  fi
done < <(git diff --cached --name-only -z --diff-filter=ACMR -- "${SRC_PATHSPECS[@]}")

# --- D. IGNORED (only with --all) -------------------------------------------
if [ "$ALL" -eq 1 ]; then
  {
    git ls-files -z -- "${SRC_PATHSPECS[@]}"
    git ls-files --others --exclude-standard -z -- "${SRC_PATHSPECS[@]}"
  } | tr '\0' '\n' | sort -u > "$WORK/git-known.txt"

  ignored_hits=0
  while IFS= read -r -d '' f; do
    f="${f#./}"
    grep -a -q -x -F -- "$f" "$WORK/git-known.txt" && continue   # already covered by A/B
    [ -f "$f" ] && [ -r "$f" ] || continue
    n_scanned=$((n_scanned + 1))
    if has_nul "$f"; then
      if [ "$ignored_hits" -eq 0 ]; then
        echo "$PROG: FAIL (D/IGNORED) — raw NUL byte (0x00) in a GITIGNORED source file:" >&2
        echo "$PROG: (never published, but read with grep every day — equally blinding)" >&2
      fi
      ignored_hits=$((ignored_hits + 1)); fail=1
      report_hit "$f" "$f"
    fi
  done < <(find . \
             \( -name node_modules -o -name dist -o -name build -o -name target \
                -o -name .git -o -name .claude -o -name out -o -name coverage \
                -o -name .next -o -name .turbo -o -name vendor -o -name .venv \) -prune -o \
             -type f \( "${FIND_NAME_ARGS[@]}" \) -print0 2>/dev/null)
fi

# ===========================================================================
if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "$PROG: a NUL byte makes grep(1) treat the whole file as BINARY. It then" >&2
  echo "$PROG: prints no matches and exits 1 — identical to 'the symbol is not" >&2
  echo "$PROG: there'. Nothing errors, and the file still typechecks." >&2
  echo "" >&2
  echo "$PROG: DO NOT just delete the byte. Every one found in this codebase so" >&2
  echo "$PROG: far was a deliberate separator inside a string literal, and" >&2
  echo "$PROG: deleting it changes that string's VALUE (an empty separator, a" >&2
  echo "$PROG: weaker sentinel). Replace the raw byte with the escape \\u0000 —" >&2
  echo "$PROG: same runtime string, no NUL on disk, grep works again." >&2
  exit 1
fi

if [ "$ALL" -eq 1 ]; then
  echo "$PROG: OK — ${n_scanned} source file(s)/blob(s) scanned byte-for-byte, gitignored lanes included; no NUL (0x00) found."
else
  echo "$PROG: OK — ${n_scanned} source file(s)/blob(s) scanned byte-for-byte; no NUL (0x00) found."
fi
exit 0
