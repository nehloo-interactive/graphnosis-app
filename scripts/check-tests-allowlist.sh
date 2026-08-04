#!/usr/bin/env bash
# scripts/check-tests-allowlist.sh — enforcement for the 2.62c per-file negation.
#
# The `!` negations in .gitignore are the POLICY. This script is what keeps the
# policy true when someone adds a `!` line in a hurry. It reads an INDEPENDENT
# allowlist (scripts/tests-allowlist.txt) and fails if anything under tests/ is
# tracked, staged, or merely VISIBLE to git without being on it.
#
# Deriving the expectation from .gitignore itself would be tautological: the
# hurried `!` would move the goalposts and the check would nod along.
#
# THREE CHECKS, all fail-closed:
#   A. TRACKED     — `git ls-files tests/` must be a subset of the allowlist.
#                    This is the check named in 2.62c.
#   B. VISIBLE     — anything under tests/ that git does NOT ignore must be on
#                    the allowlist. Catches a stray `!` BEFORE the git add,
#                    which is the only moment at which it is still cheap.
#   C. STAGED      — the index must be a subset too, so a `git add -f` of a
#                    held file cannot slip through between A and the commit.
#
# Plus a hard denylist: paths that must NEVER become visible no matter what the
# allowlist says (real-cortex corpora, the out-of-scope study). Belt and braces
# — if someone edits the allowlist AND .gitignore, this still stops them.
#
# EXIT CODES
#   0  clean
#   1  a violation (something publishable that should not be)
#   2  self-test failed — the check's own machinery is broken, result is VOID
#   4  usage / missing prerequisite
#
# Run standalone, or from scripts/pre-commit-guard.sh.

set -o pipefail

PROG="${0##*/}"
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "$PROG: not a git repo" >&2; exit 4; }
ALLOWLIST="$ROOT/scripts/tests-allowlist.txt"

# Fail CLOSED when the allowlist is missing or empty: "no allowlist" must never
# read as "nothing is restricted".
[ -f "$ALLOWLIST" ] || { echo "$PROG: FAIL — allowlist missing: $ALLOWLIST" >&2; exit 4; }

# Paths that stay ignored permanently regardless of the allowlist.
# tests/route-b-*.json is a REAL CORTEX EXPORT — 108 real skill names, real
# sourceIds, 12 real engram names. `.clean.json` is MIS-NAMED: only the
# personal-name strings were stripped from it.
DENY_RE='^tests/(route-b-.*\.json|corpus-routing-experiment\.ts|infer-crosscheck\.ts|savings-experiment\.ts|rag-comparison-study/)'

allow_list() { grep -a -v -E '^[[:space:]]*(#|$)' "$ALLOWLIST" | sed 's/[[:space:]]*$//' | sort -u; }

ALLOWED="$(allow_list)"
n_allowed="$(printf '%s\n' "$ALLOWED" | grep -a -c . || true)"

# --- SELF-TEST: the check's own machinery must be provably live. -------------
# Same discipline as scripts/sweep.sh: a checker that reads an empty list and
# reports "clean" is indistinguishable from a clean tree.
if [ "${n_allowed:-0}" -lt 5 ]; then
  echo "$PROG: SELF-TEST FAILED — allowlist parsed to ${n_allowed:-0} entries (expected >= 5)." >&2
  echo "$PROG: The parser or the file is broken. This run's result is VOID." >&2
  exit 2
fi
# The denylist regex must actually match its canonical target.
if ! printf 'tests/route-b-fixture.clean.json\n' | grep -a -q -E "$DENY_RE"; then
  echo "$PROG: SELF-TEST FAILED — denylist regex does not match its own control needle." >&2
  exit 2
fi

fail=0
report() { printf '  %s\n' "$1"; }

# --- A. TRACKED -------------------------------------------------------------
TRACKED="$(git ls-files -- tests/ | sort -u)"
EXTRA_TRACKED="$(comm -23 <(printf '%s\n' "$TRACKED" | grep -a . || true) <(printf '%s\n' "$ALLOWED"))"
if [ -n "$EXTRA_TRACKED" ]; then
  echo "$PROG: FAIL (A/TRACKED) — files tracked under tests/ that are NOT on the allowlist:" >&2
  printf '%s\n' "$EXTRA_TRACKED" | while IFS= read -r f; do report "$f"; done >&2
  fail=1
fi

# --- B. VISIBLE (not ignored) ----------------------------------------------
# `git status --porcelain -uall` lists untracked-and-not-ignored files; combined
# with the tracked set that is exactly "what git can see under tests/".
UNTRACKED_VISIBLE="$(git ls-files --others --exclude-standard -- tests/ | sort -u)"
EXTRA_VISIBLE="$(comm -23 <(printf '%s\n' "$UNTRACKED_VISIBLE" | grep -a . || true) <(printf '%s\n' "$ALLOWED"))"
if [ -n "$EXTRA_VISIBLE" ]; then
  echo "$PROG: FAIL (B/VISIBLE) — files under tests/ are NOT ignored and NOT on the allowlist." >&2
  echo "$PROG: A '!' negation in .gitignore has outrun the allowlist. One 'git add .' publishes these:" >&2
  printf '%s\n' "$EXTRA_VISIBLE" | while IFS= read -r f; do report "$f"; done >&2
  fail=1
fi

# --- C. STAGED --------------------------------------------------------------
STAGED="$(git diff --cached --name-only --diff-filter=ACMR -- tests/ | sort -u)"
EXTRA_STAGED="$(comm -23 <(printf '%s\n' "$STAGED" | grep -a . || true) <(printf '%s\n' "$ALLOWED"))"
if [ -n "$EXTRA_STAGED" ]; then
  echo "$PROG: FAIL (C/STAGED) — staged files under tests/ that are NOT on the allowlist:" >&2
  printf '%s\n' "$EXTRA_STAGED" | while IFS= read -r f; do report "$f"; done >&2
  fail=1
fi

# --- D. HARD DENYLIST -------------------------------------------------------
ALL_SEEN="$(printf '%s\n%s\n%s\n' "$TRACKED" "$UNTRACKED_VISIBLE" "$STAGED" | grep -a . | sort -u)"
DENIED="$(printf '%s\n' "$ALL_SEEN" | grep -a -E "$DENY_RE" || true)"
if [ -n "$DENIED" ]; then
  echo "$PROG: FAIL (D/DENYLIST) — real-cortex corpora / out-of-scope study are visible to git:" >&2
  printf '%s\n' "$DENIED" | while IFS= read -r f; do report "$f"; done >&2
  echo "$PROG: These must stay ignored PERMANENTLY. Do not add them to the allowlist." >&2
  fail=1
fi

# Also flag an allowlist entry that is itself on the denylist.
SELF_CONTRADICTION="$(printf '%s\n' "$ALLOWED" | grep -a -E "$DENY_RE" || true)"
if [ -n "$SELF_CONTRADICTION" ]; then
  echo "$PROG: FAIL (D/DENYLIST) — the allowlist itself names a permanently-blocked path:" >&2
  printf '%s\n' "$SELF_CONTRADICTION" | while IFS= read -r f; do report "$f"; done >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "$PROG: tests/ publication is FAIL-CLOSED by design. To publish a file:" >&2
  echo "  1. classify it (a)/(b)/(c) per the 2.59a disclosure classification" >&2
  echo "  2. add its path to scripts/tests-allowlist.txt" >&2
  echo "  3. add the matching '!' negation to .gitignore" >&2
  echo "  Doing only one of 2 and 3 is what this check exists to catch." >&2
  exit 1
fi

n_tracked="$(printf '%s\n' "$TRACKED" | grep -a -c . || true)"
n_visible="$(printf '%s\n' "$UNTRACKED_VISIBLE" | grep -a -c . || true)"
echo "$PROG: OK — allowlist ${n_allowed} entries; tests/ tracked ${n_tracked:-0}, visible-untracked ${n_visible:-0}; all within the allowlist; denylist clear."
exit 0
