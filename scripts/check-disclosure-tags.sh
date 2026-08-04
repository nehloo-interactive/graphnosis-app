#!/usr/bin/env bash
# scripts/check-disclosure-tags.sh — makes the 2.59a disclosure classification
# MACHINE-CHECKABLE, so it stops going stale the moment something ships.
#
# THE PROBLEM THIS SOLVES
# -----------------------
# 31 (c) + 6 (b) suites are working, runnable reproductions of defects that are
# LIVE for every user on the shipped build. A regression test for a live defect
# is a working reproduction of it, with a runner attached. The classification
# that says so lives in a markdown file, and a markdown file cannot stop a
# `git add .`.
#
# So the classification now lives in the files themselves, one line per suite:
#
#     // @disclosure: (<class>) <label> - <why> <adoption event>
#     // @disclosure-src: 2.59a S5.2 - held by scripts/disclosure-held.txt
#
# classes:  (a) publishable - (b) fix-not-adopted - (c) live-on-shipped
#
# and this script REFUSES to let anything tagged (b) or (c) become tracked.
#
# HOW THIS COMPOSES WITH scripts/check-tests-allowlist.sh (2.62c)
# ---------------------------------------------------------------
# The two checks are on DIFFERENT AXES and neither reimplements the other:
#
#   check-tests-allowlist.sh  PATH policy, scoped to tests/ only.
#                             "which paths may be tracked."  Its input is
#                             scripts/tests-allowlist.txt.
#   check-disclosure-tags.sh  CONTENT policy, repo-wide.
#                             "what a file DECLARES ITSELF to be."  Its input
#                             is the header tags + scripts/disclosure-held.txt.
#
# This matters concretely: apps/desktop-sidecar/tests/ is NOT in the other
# check's jurisdiction and is NOT gitignored, so the (b)/(c) sidecar suites are
# visible to git right now and the allowlist check cannot see them. That gap is
# this script's whole reason to exist, and section E reports it.
#
# The one place the two touch is the CONTRADICTION check (section C): a path on
# the allowlist that carries a (b)/(c) tag, or a path on both lists, is a
# disagreement between the two policies and fails here. That is composition -
# this script reads the other's list to check consistency WITH it, never to
# re-derive its verdict.
#
# SECTIONS
#   S. SELF-TEST     - both scan engines proven live against controls. exit 2.
#   H. INTEGRITY     - every held path exists and still carries a (b)/(c) tag.
#   R. REFUSAL       - nothing tagged (b)/(c) is tracked or staged.
#   N. UNCLASSIFIED  - no untagged new suite in the two classified lanes.
#   C. CONTRADICTION - held list and tests-allowlist cannot disagree.
#   E. EXPOSURE      - (b)/(c) files merely VISIBLE to git (one `git add .`).
#
# EXIT CODES
#   0  clean
#   1  REFUSED   - something held is tracked/staged, tampered with, or the two
#                  policy lists contradict each other. Blocks publication.
#   2  self-test failed - this check's own machinery is broken, result is VOID.
#   3  EXPOSED   - nothing is tracked yet, but held files are not ignored
#                  either, so one `git add .` publishes them. Distinct code
#                  because the remedy is a .gitignore line, not a revert.
#   4  usage / missing prerequisite.
#   Precedence when several apply: 2 > 4 > 1 > 3.
#
# Run standalone, or from scripts/pre-commit-guard.sh.
# NOTE for whoever wires it into that guard: scripts/tests/pre-commit-guard.test.sh
# copies ONLY pre-commit-guard.sh into its throwaway repos, so a bare call to a
# sibling script will make every case in that suite fail closed. Copy the
# siblings in `fresh_repo` in the same commit that adds the call.

set -o pipefail

# --- re-entrant worktree scanner --------------------------------------------
# Kept at the very top so the recursive invocation costs one awk and nothing
# else. Prints the paths whose first WINDOW lines match the regex.
if [ "${1:-}" = "--awk-scan" ]; then
  __re="$2"; __win="$3"; shift 3
  [ "$#" -gt 0 ] || exit 0
  exec awk -v re="$__re" -v win="$__win" '
    FNR == 1 { hit = 0 }
    !hit && FNR <= win && $0 ~ re { print FILENAME; hit = 1 }
  ' "$@"
fi

# Byte collation, so every sort/comm pairing below is consistent. The check
# compares SETS of paths; a collation mismatch between two `sort` calls makes
# `comm` silently drop members, which is exactly the class of silent false
# negative this audit keeps hitting.
export LC_ALL=C

PROG="${0##*/}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SELF="$SCRIPT_DIR/$PROG"
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "$PROG: not a git repo" >&2; exit 4; }
cd "$ROOT" || exit 4

HELD_FILE="$SCRIPT_DIR/disclosure-held.txt"
ALLOWLIST="$SCRIPT_DIR/tests-allowlist.txt"

# Lanes whose *.mjs / *.ts files must ALL carry a tag once git can see them.
# scripts/forensics/ added 2026-08-03: two held files sat OUTSIDE this pattern,
# so the check reported clean while they were fully committable. A lane the
# checker cannot see is a lane it does not protect.
LANE_RE='^(apps/desktop-sidecar/tests/|tests/desktop/|scripts/forensics/)[^/]*\.(mjs|ts)$'

# A disclosure tag is a HEADER declaration. If it is not in the header it is
# not a tag - that keeps a prose mention deep inside a fixture from reading as
# a classification, and keeps "move the tag to line 900" from being a bypass
# (moving it out of the window makes the file untagged, which fails section N).
WINDOW=60

# The regexes carry NO backslashes, on purpose. They are evaluated by TWO
# engines - `git grep -E` for index content and `awk` for worktree content -
# and a backslash escape is exactly where those two dialects drift. `[(]` and
# `[)]` are literal parens in both, with no escaping, so the engines cannot
# disagree. The self-test proves they do not.
TAG_BC_RE='^[[:blank:]]*[/#*]*[[:blank:]]*@disclosure:[[:blank:]]*[(][bc][)]'
TAG_ANY_RE='^[[:blank:]]*[/#*]*[[:blank:]]*@disclosure:[[:blank:]]*[(][abc][)]'

WORK="$(mktemp -d "${TMPDIR:-/tmp}/disclosure-tags.XXXXXX")" || { echo "$PROG: mktemp failed" >&2; exit 4; }
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

[ -f "$HELD_FILE" ] || { echo "$PROG: FAIL - held list missing: $HELD_FILE" >&2; exit 4; }
[ -f "$ALLOWLIST" ] || { echo "$PROG: FAIL - allowlist missing: $ALLOWLIST (2.62c must land first)" >&2; exit 4; }

strip_list() { grep -a -v -E '^[[:space:]]*(#|$)' "$1" | sed 's/[[:space:]]*$//' | sort -u; }

HELD="$(strip_list "$HELD_FILE")"
ALLOWED="$(strip_list "$ALLOWLIST")"
n_held="$(printf '%s\n' "$HELD" | grep -a -c . || true)"
n_allowed="$(printf '%s\n' "$ALLOWED" | grep -a -c . || true)"

scan_files() {  # scan_files <regex> <path>...  -> matching paths
  local re="$1"; shift
  [ "$#" -gt 0 ] || return 0
  "$SELF" --awk-scan "$re" "$WINDOW" "$@"
}

# `git grep --cached` searches the INDEX, not the worktree. That distinction is
# the whole point: `git add` a tagged file, then delete the tag from the
# worktree copy, and a worktree scan reports clean while the staged blob still
# carries it. This repo's guard already shipped a fix for exactly that class of
# miss; do not "simplify" this into a worktree read.
scan_index() {  # scan_index <regex> -> paths, one per line
  # `-e` is not optional: without it git grep parses a pattern that starts with
  # a dash as options and then reads the next word as a REVISION, which fails
  # with "unable to resolve revision" - or, with 2>/dev/null, as SILENCE.
  git grep -a -I -n --cached -E -e "$1" -- . 2>/dev/null \
    | awk -F: -v win="$WINDOW" '$2 + 0 <= win { print $1 }' \
    | sort -u
}

# ===========================================================================
# S. SELF-TEST - every clean negative below must be a CONTROLLED negative.
# ===========================================================================
st_fail() { echo "$PROG: SELF-TEST FAILED - $1" >&2; echo "$PROG: this run's result is VOID." >&2; exit 2; }

[ "${n_held:-0}"    -ge 20 ] || st_fail "held list parsed to ${n_held:-0} entries (expected >= 20). Parser or file broken."
[ "${n_allowed:-0}" -ge 5  ] || st_fail "allowlist parsed to ${n_allowed:-0} entries (expected >= 5)."

# Controls: three lines that MUST match, three decoys that MUST NOT. The decoys
# are the near-misses that would silently break this check - the -src companion
# line, an (a) tag under the (b)/(c) regex, and a prose mention mid-line.
CTL="$WORK/ctl"; mkdir -p "$CTL"
KEY='@''disclosure'                    # split so THIS file cannot self-match
printf '// %s: (c) live-on-shipped - control\n' "$KEY" > "$CTL/pos-c.txt"
printf ' * %s: (b) fix-not-adopted - control\n'  "$KEY" > "$CTL/pos-b.txt"
printf '#%s: (c) no-space control\n'             "$KEY" > "$CTL/pos-nospace.txt"
printf '// %s-src: 2.59a (c) decoy\n'            "$KEY" > "$CTL/neg-src.txt"
printf '// %s: (a) publishable - decoy\n'        "$KEY" > "$CTL/neg-a.txt"
printf 'assert(t.includes("%s: (c)"));\n'        "$KEY" > "$CTL/neg-prose.txt"
CTL_FILES=("$CTL/pos-c.txt" "$CTL/pos-b.txt" "$CTL/pos-nospace.txt" "$CTL/neg-src.txt" "$CTL/neg-a.txt" "$CTL/neg-prose.txt")

ctl_hits() { scan_files "$1" "${CTL_FILES[@]}" | sed 's#.*/##' | sort | tr '\n' ' '; }

GOT_BC="$(ctl_hits "$TAG_BC_RE")"
[ "$GOT_BC" = "pos-b.txt pos-c.txt pos-nospace.txt " ] \
  || st_fail "awk engine, (b)/(c) regex: expected 'pos-b.txt pos-c.txt pos-nospace.txt ', got '$GOT_BC'."
GOT_ANY="$(ctl_hits "$TAG_ANY_RE")"
[ "$GOT_ANY" = "neg-a.txt pos-b.txt pos-c.txt pos-nospace.txt " ] \
  || st_fail "awk engine, any-class regex: expected the (a) decoy to be SEEN, got '$GOT_ANY'."

# Engine parity: git grep must agree with awk on the identical control corpus.
# This is the check that catches ERE-dialect drift between the two scanners.
PARITY="$( ( cd "$CTL" && git grep -a -I --no-index -l -E -e "$TAG_BC_RE" -- . 2>/dev/null ) | sed 's#.*/##' | sort | tr '\n' ' ')"
[ "$PARITY" = "pos-b.txt pos-c.txt pos-nospace.txt " ] \
  || st_fail "git-grep engine disagrees with awk on the control corpus: got '$PARITY'. The two scanners have drifted."

# The INDEX scanner must be proven live too, and the control is DERIVED rather
# than hardcoded: pick a tracked file, pull a word out of its own index blob,
# and require `git grep --cached` to find that word in that file. A hardcoded
# needle rots the day someone edits the file it points at, and a rotted control
# that is quietly dropped turns every negative below into an unproven one.
CTL_PATH="$(git ls-files -- '*.ts' '*.json' '*.sh' '*.mjs' | head -1)"
[ -n "$CTL_PATH" ] || st_fail "no tracked .ts/.json/.sh/.mjs file to build an index-scanner control from."
CTL_NEEDLE="$(git cat-file blob ":0:$CTL_PATH" 2>/dev/null | grep -a -o -E '[A-Za-z]{6,}' | head -1)"
[ -n "$CTL_NEEDLE" ] || st_fail "could not extract a control needle from the index blob of $CTL_PATH."
if ! git grep -a -I -q --cached -F -e "$CTL_NEEDLE" -- "$CTL_PATH" 2>/dev/null; then
  st_fail "index scanner found nothing for '$CTL_NEEDLE', a word taken from the index blob of $CTL_PATH itself. 'git grep --cached' is not searching."
fi

worst=0
# Precedence is 2 > 4 > 1 > 3 > 0, which is NOT numeric order. A plain
# `[ "$1" -gt "$worst" ]` lets a mere EXPOSURE (3) overwrite a REFUSAL (1), so
# a run that found tracked (b)/(c) content reports the softer verdict and the
# caller reads "just a .gitignore gap". Rank explicitly.
rank() { case "$1" in 0) echo 0;; 3) echo 1;; 1) echo 2;; 4) echo 3;; 2) echo 4;; *) echo 9;; esac; }
bump() { if [ "$(rank "$1")" -gt "$(rank "$worst")" ]; then worst="$1"; fi; }
report() { printf '  %s\n' "$1" >&2; }
dump()   { printf '%s' "$1" | while IFS= read -r f; do [ -n "$f" ] && report "$f"; done; }

# ===========================================================================
# What git can see, in three states.
# ===========================================================================
TRACKED="$(git ls-files | sort -u)"
STAGED="$(git diff --cached --name-only --diff-filter=ACMR | sort -u)"
UNTRACKED_VISIBLE="$(git ls-files --others --exclude-standard | sort -u)"
HEAD_FILES="$(git ls-tree -r --name-only HEAD 2>/dev/null | sort -u)"
IN_INDEX="$(printf '%s\n%s\n' "$TRACKED" "$STAGED" | grep -a . | sort -u)"

# ===========================================================================
# H. INTEGRITY - the held list is the independent witness against tampering.
# ===========================================================================
h_missing=""; h_untagged=""
while IFS= read -r p; do
  [ -n "$p" ] || continue
  if [ ! -f "$p" ]; then h_missing="$h_missing$p"$'\n'; continue; fi
  if [ -z "$(scan_files "$TAG_BC_RE" "$p")" ]; then h_untagged="$h_untagged$p"$'\n'; fi
done <<EOF
$HELD
EOF

if [ -n "$h_missing" ]; then
  echo "$PROG: FAIL (H/INTEGRITY) - held paths do not exist:" >&2
  dump "$h_missing"
  echo "$PROG: a held file was deleted or moved without editing $HELD_FILE." >&2
  bump 1
fi
if [ -n "$h_untagged" ]; then
  echo "$PROG: FAIL (H/INTEGRITY) - held paths no longer carry a (b)/(c) disclosure tag in their first $WINDOW lines:" >&2
  dump "$h_untagged"
  echo "$PROG: deleting the header does NOT declassify the file. Restore the tag, or" >&2
  echo "$PROG: remove the path from $HELD_FILE with the adoption event named." >&2
  bump 1
fi

# ===========================================================================
# R. REFUSAL - the check this script exists for. Nothing (b)/(c) is trackable.
# ===========================================================================
BAD_INDEX="$(scan_index "$TAG_BC_RE" | grep -a . || true)"
if [ -n "$BAD_INDEX" ]; then
  echo "$PROG: FAIL (R/REFUSAL) - files tagged (b)/(c) are TRACKED or STAGED:" >&2
  dump "$BAD_INDEX"$'\n'
  echo "$PROG: each is a runnable reproduction of a defect live on the shipped build." >&2
  echo "$PROG: unstage it:  git reset HEAD -- <path>   (or git rm --cached <path>)" >&2
  bump 1
fi

# ===========================================================================
# N. UNCLASSIFIED - a new suite in a classified lane must declare a class.
#    Scoped to files NOT already in HEAD: the pre-audit suites tracked before
#    2.59a were never classified by it, and retro-tagging them is an owner
#    decision, not this check's.
# ===========================================================================
LANE_SEEN="$(printf '%s\n%s\n%s\n' "$TRACKED" "$STAGED" "$UNTRACKED_VISIBLE" | grep -a . | sort -u | grep -a -E "$LANE_RE" || true)"
LANE_NEW="$(comm -23 <(printf '%s\n' "$LANE_SEEN" | grep -a . || true) <(printf '%s\n' "$HEAD_FILES"))"

n_staged_untagged=""; n_visible_untagged=""
while IFS= read -r p; do
  [ -n "$p" ] || continue
  [ -f "$p" ] || continue
  [ -z "$(scan_files "$TAG_ANY_RE" "$p")" ] || continue
  if printf '%s\n' "$IN_INDEX" | grep -a -q -x -F -- "$p"; then
    n_staged_untagged="$n_staged_untagged$p"$'\n'
  else
    n_visible_untagged="$n_visible_untagged$p"$'\n'
  fi
done <<EOF
$LANE_NEW
EOF

if [ -n "$n_staged_untagged$n_visible_untagged" ]; then
  echo "$PROG: FAIL (N/UNCLASSIFIED) - new suites in a classified lane carry no @disclosure tag" >&2
  echo "$PROG: in their first $WINDOW lines. The default for an unclassified suite is (c)." >&2
  if [ -n "$n_staged_untagged" ]; then
    echo "  TRACKED or STAGED (refused):" >&2; dump "$n_staged_untagged"; bump 1
  fi
  if [ -n "$n_visible_untagged" ]; then
    echo "  visible, not yet tracked (exposure):" >&2; dump "$n_visible_untagged"; bump 3
  fi
fi

# ===========================================================================
# C. CONTRADICTION - composition with 2.62c. The two lists cannot disagree.
# ===========================================================================
BOTH="$(comm -12 <(printf '%s\n' "$HELD") <(printf '%s\n' "$ALLOWED") | grep -a . || true)"
if [ -n "$BOTH" ]; then
  echo "$PROG: FAIL (C/CONTRADICTION) - paths on BOTH scripts/tests-allowlist.txt (publishable)" >&2
  echo "$PROG: and $HELD_FILE (held):" >&2
  dump "$BOTH"$'\n'
  bump 1
fi

allow_bc=""
while IFS= read -r p; do
  [ -n "$p" ] || continue
  [ -f "$p" ] || continue
  if [ -n "$(scan_files "$TAG_BC_RE" "$p")" ]; then allow_bc="$allow_bc$p"$'\n'; fi
done <<EOF
$ALLOWED
EOF
if [ -n "$allow_bc" ]; then
  echo "$PROG: FAIL (C/CONTRADICTION) - allowlisted (publishable) paths carry a (b)/(c) tag:" >&2
  dump "$allow_bc"
  echo "$PROG: the path policy and the content policy disagree. Resolve before committing." >&2
  bump 1
fi

# ===========================================================================
# E. EXPOSURE - visible but not yet tracked. One `git add .` from publication.
# ===========================================================================
: > "$WORK/visible-bc.raw"
chunk=(); n=0
while IFS= read -r -d '' f; do
  chunk+=("$f"); n=$((n + 1))
  if [ "$n" -ge 400 ]; then
    scan_files "$TAG_BC_RE" "${chunk[@]}" >> "$WORK/visible-bc.raw"
    chunk=(); n=0
  fi
done < <(git ls-files --others --exclude-standard -z)
[ "$n" -gt 0 ] && scan_files "$TAG_BC_RE" "${chunk[@]}" >> "$WORK/visible-bc.raw"
sort -u "$WORK/visible-bc.raw" > "$WORK/visible-bc.txt"

EXPOSED="$(comm -23 "$WORK/visible-bc.txt" <(printf '%s\n' "$IN_INDEX") | grep -a . || true)"
n_exposed="$(printf '%s' "$EXPOSED" | grep -a -c . || true)"
if [ "${n_exposed:-0}" -gt 0 ]; then
  echo "$PROG: FAIL (E/EXPOSURE) - ${n_exposed} file(s) tagged (b)/(c) are NOT ignored by git." >&2
  echo "$PROG: nothing is tracked yet, so nothing has been published - but a single" >&2
  echo "$PROG: 'git add .' or 'git add -A' publishes every one of them." >&2
  printf '%s\n' "$EXPOSED" | head -60 | while IFS= read -r f; do [ -n "$f" ] && report "$f"; done
  echo "$PROG: the remedy is a .gitignore rule, not a revert. Directories involved:" >&2
  printf '%s\n' "$EXPOSED" | sed 's#/[^/]*$##' | sort -u | while IFS= read -r d; do
    [ -n "$d" ] && report "/$d/*    then '!' back only the class-(a) files"
  done
  bump 3
fi

# ===========================================================================
case "$worst" in
  0) echo "$PROG: OK - ${n_held} held (b)/(c) files, all present and tagged; none tracked, staged or visible;" \
          "no unclassified suite in the sidecar/desktop lanes; no contradiction with the ${n_allowed}-entry allowlist." ;;
  1) echo "" >&2
     echo "$PROG: REFUSED (exit 1). The 2.59a classification is the authority:" >&2
     echo "  Graphnosis/data/audit-archive/findings/PII-DISCLOSURE-TESTTREE-2.59a.md" >&2 ;;
  3) echo "" >&2
     echo "$PROG: EXPOSED (exit 3). Nothing published yet; close the gap before the next commit." >&2 ;;
esac
exit "$worst"
