#!/usr/bin/env bash
# scripts/pre-commit-checks.sh — the composite the pre-commit hook runs.
#
# WHY THIS FILE EXISTS (and why the checks were NOT bolted onto the guard)
# -----------------------------------------------------------------------
# Until now .githooks/pre-commit ran scripts/pre-commit-guard.sh and nothing
# else. scripts/check-tests-allowlist.sh and scripts/check-disclosure-tags.sh
# were invoked by NOTHING — not by the hook, not by any GitHub workflow — even
# though both headers claimed they ran "from scripts/pre-commit-guard.sh". A
# control that nothing calls is not a control.
#
# The obvious fix — call the siblings from inside pre-commit-guard.sh — breaks
# scripts/tests/pre-commit-guard.test.sh. That suite builds ~20 throwaway repos
# and copies ONLY pre-commit-guard.sh into each, so a bare sibling call makes
# every case fail closed on a missing file. Copying the siblings into the
# fixture does not fix it either: they need their own data files
# (tests-allowlist.txt, disclosure-held.txt) and a repo shaped like this one,
# and their self-tests demand >= 5 and >= 20 entries respectively. The fixture
# would have to impersonate this repository to test something unrelated to it.
#
# So the composite is a separate file. pre-commit-guard.sh keeps its single
# job (needles + smoketest artifacts) and its suite keeps passing UNMODIFIED,
# while the hook gains the other three checks. Each member is one job; this
# file is the running order.
#
# MISSING IS NOT PASSING
# ----------------------
# Every member below is REQUIRED. A member that is absent, unreadable, or not
# a regular file is a REFUSAL (exit 4), never a skip — because "the check did
# not run" and "the check found nothing" must never produce the same outcome.
# That is the exact defect class the NUL-byte work exists to close: a grep that
# silently refuses to search looks identical to a grep that found nothing.
#
# The summary table printed at the end names every member and its verdict, so
# a member that did not run is VISIBLE rather than inferred from silence. There
# is deliberately no skip flag and no environment variable that disables a
# member: the documented escape hatch is `git commit --no-verify`, which is
# explicit, per-commit, and shows up in nobody's muscle memory by accident.
#
# EXIT CODES (aggregate)
#   0  every member clean
#   1  a member reported a violation
#   2  a member's SELF-TEST failed — that member's result is VOID
#   3  a member reported EXPOSURE only (nothing tracked yet)
#   4  a required member is missing / unreadable, or a prerequisite failed
#   Precedence when several apply: 2 > 4 > 1 > 3.
#
# Run standalone:  bash scripts/pre-commit-checks.sh
# Invoked by:      .githooks/pre-commit  (core.hooksPath=.githooks)

set -o pipefail
export LC_ALL=C

PROG="${0##*/}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

git rev-parse --git-dir >/dev/null 2>&1 || {
  echo "$PROG: REFUSING — not inside a git repository." >&2; exit 4; }

# --- THE MANIFEST -----------------------------------------------------------
# Order matters only for readability of the output; every member always runs,
# so one failure never hides another.
MEMBERS=(
  "pre-commit-guard.sh|personal names / fixture data / smoketest artifacts"
  "check-nul-bytes.sh|raw NUL bytes that make grep silently skip a file"
  "check-tests-allowlist.sh|tests/ path policy (what may be tracked)"
  "check-disclosure-tags.sh|(b)/(c) disclosure content policy"
)

rank() { case "$1" in 0) echo 0;; 3) echo 1;; 1) echo 2;; 4) echo 3;; 2) echo 4;; *) echo 5;; esac; }
worst=0
bump() { if [ "$(rank "$1")" -gt "$(rank "$worst")" ]; then worst="$1"; fi; }

declare -a SUMMARY=()

for spec in "${MEMBERS[@]}"; do
  name="${spec%%|*}"; what="${spec#*|}"
  path="$SCRIPT_DIR/$name"

  # ---- MISSING IS A REFUSAL, NOT A SKIP -----------------------------------
  if [ ! -f "$path" ] || [ ! -r "$path" ]; then
    echo "$PROG: REFUSING — required check is missing or unreadable: $path" >&2
    echo "$PROG: a check that did not run is NOT a check that passed. Restore the" >&2
    echo "$PROG: file, or remove it from the MEMBERS manifest in $PROG deliberately." >&2
    SUMMARY+=("MISSING  $name  — $what")
    bump 4
    continue
  fi

  echo "── $name — $what"
  bash "$path"
  rc=$?
  case "$rc" in
    0) SUMMARY+=("ran, PASS ($rc)  $name") ;;
    2) SUMMARY+=("ran, VOID ($rc)  $name  — its own self-test failed") ;;
    3) SUMMARY+=("ran, EXPOSED ($rc)  $name") ;;
    4) SUMMARY+=("ran, PREREQ ($rc)  $name") ;;
    *) SUMMARY+=("ran, FAIL ($rc)  $name  — $what") ;;
  esac
  bump "$rc"
  echo
done

# --- SUMMARY: every member accounted for, by name --------------------------
echo "$PROG: ${#MEMBERS[@]} required check(s):"
for line in "${SUMMARY[@]}"; do printf '    %s\n' "$line"; done

if [ "$worst" -ne 0 ]; then
  echo "" >&2
  case "$worst" in
    2) echo "$PROG: BLOCKED (exit 2) — a check's own machinery is broken, so its" >&2
       echo "$PROG: result proves nothing. Fix the checker before committing." >&2 ;;
    4) echo "$PROG: BLOCKED (exit 4) — a required check did not run." >&2 ;;
    3) echo "$PROG: BLOCKED (exit 3) — held content is exposed to a 'git add .'." >&2 ;;
    *) echo "$PROG: BLOCKED (exit 1) — a check reported a violation, named above." >&2 ;;
  esac
  echo "$PROG: deliberate exception: git commit --no-verify" >&2
  exit "$worst"
fi

echo "$PROG: OK — all ${#MEMBERS[@]} checks ran and passed."
exit 0
