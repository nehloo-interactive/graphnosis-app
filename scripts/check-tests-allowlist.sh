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
#   D. DENYLIST    — the named permanent blocks, above.
#   E. SHAPE       — an ARTIFACT-KIND rule, not a list of instances. See the
#                    SHAPE_OK_RE comment below for why the kind is the closest
#                    mechanical stand-in for the disclosure class.
#
# EXIT CODES
#   0  clean
#   1  a violation (something publishable that should not be)
#   2  self-test failed — the check's own machinery is broken, result is VOID
#   4  usage / missing prerequisite
#
# WHERE THIS RUNS
#   scripts/pre-commit-checks.sh, which .githooks/pre-commit execs on every
#   commit (core.hooksPath=.githooks). Also runnable standalone.
#
#   Until 2026-08-05 this line claimed it ran "from scripts/pre-commit-guard.sh".
#   It did not: that guard never called any sibling, so this check was invoked
#   by nothing — not the hook, not any GitHub workflow. The composite above is
#   what made the claim true; do not weaken it back into a comment.

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

# --- PUBLISHABLE SHAPE ------------------------------------------------------
# WHY A SHAPE RULE AND NOT MORE NAMES
# The 2.59a class the allowlist is supposed to encode — (a) = "defect fixed AND
# adopted by every shipped consumer" — is not mechanically decidable here: "has
# the fix shipped yet" is release state this script cannot read, and a class
# whose header tag someone typed is a claim, not a measurement. What IS decidable
# is the ARTIFACT KIND, and in this tree the two travel together. The publishable
# set has only ever been of two kinds:
#
#   1. regression SUITES the runner executes  ->  *.test.ts
#   2. the harness and fixtures they need     ->  _*.ts / _*.mjs, run-all.ts,
#                                                 tsconfig.json, fixtures/*
#
# Every standalone, hand-run script that has ever landed under tests/ — the
# `*-proof.ts` reproductions, `*-experiment.ts`, `infer-crosscheck.ts` — is one
# of the two kinds the .gitignore header says never ship: a real-cortex corpus,
# or a working, runnable reproduction of a defect live on the shipped build.
# Such a script is refused here REGARDLESS of the allowlist, exactly as the
# corpora are.
#
# This is deliberately NOT a denylist of known files. The lesson that produced
# this section is that enumerating the reproductions written so far misses the
# next one; a kind rule catches it the day it is written, with no edit here.
#
# TO PUBLISH SOMETHING OF ANOTHER KIND: extend this regex in the same reviewed
# change that adds the path to the allowlist and the `!` to .gitignore, and say
# in the commit which kind is being admitted and why it carries no defect
# content. A fail-closed default is the point — see the .gitignore header,
# "Publication is never the default".
SHAPE_OK_RE='(\.test\.ts$|^tests/run-all\.ts$|^tests/([^/]+/)?_[^/]+$|^tests/fixtures/|^tests/([^/]+/)?tsconfig\.json$)'

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
# The shape regex needs BOTH directions proven. A regex that matches everything
# reports "clean" forever; one that matches nothing refuses everything and gets
# switched off within the week. The needles are SYNTHETIC paths, so neither
# control rots when a real file is renamed.
for needle in 'tests/example.test.ts' 'tests/run-all.ts' 'tests/_helpers.ts' \
              'tests/desktop/_loader.mjs' 'tests/desktop/tsconfig.json' \
              'tests/fixtures/example-golden.json'; do
  if ! printf '%s\n' "$needle" | grep -a -q -E "$SHAPE_OK_RE"; then
    echo "$PROG: SELF-TEST FAILED — shape regex rejects publishable control needle '$needle'." >&2
    echo "$PROG: a shape rule that refuses the established publishable set is broken, not strict." >&2
    exit 2
  fi
done
for needle in 'tests/example-proof.ts' 'tests/example-experiment.ts' 'tests/example-repro.mjs'; do
  if printf '%s\n' "$needle" | grep -a -q -E "$SHAPE_OK_RE"; then
    echo "$PROG: SELF-TEST FAILED — shape regex accepts ad-hoc-script control needle '$needle'." >&2
    exit 2
  fi
done

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

# --- E. PUBLISHABLE SHAPE ---------------------------------------------------
# Two arms, mirroring D. The first catches the file once git can see it; the
# second catches the allowlist entry even while the `!` negation is still
# missing, i.e. at the half-done stage where the mistake is cheapest to undo.
WRONG_SHAPE="$(printf '%s\n' "$ALL_SEEN" | grep -a . | grep -a -v -E "$SHAPE_OK_RE" || true)"
if [ -n "$WRONG_SHAPE" ]; then
  echo "$PROG: FAIL (E/SHAPE) — files under tests/ that git can see are neither a" >&2
  echo "$PROG: *.test.ts suite nor named harness/fixture:" >&2
  printf '%s\n' "$WRONG_SHAPE" | while IFS= read -r f; do report "$f"; done >&2
  echo "$PROG: a standalone hand-run script under tests/ is, in this tree, always one of" >&2
  echo "$PROG: the two kinds that never ship — a real-cortex corpus, or a working," >&2
  echo "$PROG: runnable reproduction of a defect LIVE on the shipped build (2.59a class" >&2
  echo "$PROG: (b)/(c)). Those become publishable only at an ADOPTION EVENT — a release" >&2
  echo "$PROG: carrying the fix — never by a decision to publish them. See" >&2
  echo "$PROG: scripts/disclosure-held.txt, 'TO REMOVE A PATH FROM THIS LIST'." >&2
  fail=1
fi

WRONG_SHAPE_ALLOWED="$(printf '%s\n' "$ALLOWED" | grep -a -v -E "$SHAPE_OK_RE" || true)"
if [ -n "$WRONG_SHAPE_ALLOWED" ]; then
  echo "$PROG: FAIL (E/SHAPE) — the allowlist names paths that are not of a publishable kind:" >&2
  printf '%s\n' "$WRONG_SHAPE_ALLOWED" | while IFS= read -r f; do report "$f"; done >&2
  echo "$PROG: allowlisting a hand-run script is how a class (b)/(c) reproduction gets" >&2
  echo "$PROG: published. Remove the entry, or admit the kind in $PROG's SHAPE_OK_RE in" >&2
  echo "$PROG: the same reviewed change." >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "$PROG: tests/ publication is FAIL-CLOSED by design. To publish a file:" >&2
  echo "  1. classify it (a)/(b)/(c) per the 2.59a disclosure classification" >&2
  echo "  2. add its path to scripts/tests-allowlist.txt" >&2
  echo "  3. add the matching '!' negation to .gitignore" >&2
  echo "  Doing only one of 2 and 3 is what this check exists to catch." >&2
  echo "  Doing all three to a class (b)/(c) file is what section E exists to catch:" >&2
  echo "  only an ADOPTION EVENT declassifies it, not a decision to publish." >&2
  exit 1
fi

n_tracked="$(printf '%s\n' "$TRACKED" | grep -a -c . || true)"
n_visible="$(printf '%s\n' "$UNTRACKED_VISIBLE" | grep -a -c . || true)"
echo "$PROG: OK — allowlist ${n_allowed} entries; tests/ tracked ${n_tracked:-0}, visible-untracked ${n_visible:-0}; all within the allowlist; denylist clear; every path of a publishable kind."
exit 0
