#!/usr/bin/env bash
# scripts/sweep.sh — a sweep that CANNOT silently return clean.
#
# WHY THIS EXISTS
# ---------------
# A broken sweep and a clean tree are indistinguishable from the outside: both
# print nothing and exit 0. FIVE distinct tooling traps have already produced a
# confident wrong answer in this audit:
#
#   1. `grep` misdetects source files as binary and skips them silently
#      -> always `grep -a`.
#   2. `rg` is a SHELL FUNCTION here, so `... | xargs rg` runs NOTHING and
#      exits 0 -> never pipe into rg; use `xargs grep -a`.
#   3. `\s` is not POSIX ERE on macOS -> `grep -E '\s'` matches a literal `s`.
#   4. zsh parses `git cat-file -p "$c:path"` inside a loop as a history
#      modifier -> dump blobs to files instead.
#   5. `git cat-file ... | grep -c` in a loop silently returns 0.
#
# The fix is structural, not a reminder. Every sweep goes through this script,
# and every sweep carries a POSITIVE CONTROL: a needle that MUST be found. If
# the control misses, the sweep machinery is broken, and the script exits
# NON-ZERO regardless of what the real needles did. A clean result is only
# trustworthy when the same machinery, in the same run, proved it can still hit.
#
# USAGE
#   scripts/sweep.sh --control <needle-that-must-hit> [options] -- <pattern>...
#
#   --control <str>     REQUIRED. A needle known to exist in the search scope.
#                       Repeatable; every one must hit.
#   --control-path <p>  Restrict control matching to this path (default: the
#                       same scope as the real sweep).
#   --path <p>          Search scope. Repeatable. Default: the repo root.
#   --fixed             Patterns are literal strings (grep -F).
#   --regex             Patterns are extended regexes (grep -E). Default.
#   --ignore-case       Case-insensitive.
#   --expect-clean      Exit non-zero if any real pattern MATCHES.
#                       (Default: matches are reported, exit stays 0.)
#   --expect-hit        Exit non-zero if any real pattern does NOT match.
#   --git-tracked       Search only files git tracks (respects .gitignore).
#   --max <n>           Max match lines to print per pattern (default 40).
#
# EXIT CODES
#   0  machinery verified AND expectations met
#   2  CONTROL MISSED — the sweep is broken; any "clean" result is void
#   3  expectation failed (--expect-clean saw a hit / --expect-hit saw none)
#   4  usage error
#
# NOTE ON `\s`: patterns are passed to `grep -E`, which on macOS/BSD does not
# understand `\s`. Use `[[:space:]]`. This script warns if it sees `\s`.

set -o pipefail

PROG="${0##*/}"

CONTROLS=()
CONTROL_PATH=""
PATHS=()
PATTERNS=()
MODE="-E"
ICASE=""
EXPECT_CLEAN=0
EXPECT_HIT=0
GIT_TRACKED=0
MAXLINES=40

die() { printf '%s: %s\n' "$PROG" "$*" >&2; exit 4; }

while [ $# -gt 0 ]; do
  case "$1" in
    --control)      [ $# -ge 2 ] || die "--control needs a value";      CONTROLS+=("$2"); shift 2 ;;
    --control-path) [ $# -ge 2 ] || die "--control-path needs a value"; CONTROL_PATH="$2"; shift 2 ;;
    --path)         [ $# -ge 2 ] || die "--path needs a value";         PATHS+=("$2"); shift 2 ;;
    --max)          [ $# -ge 2 ] || die "--max needs a value";          MAXLINES="$2"; shift 2 ;;
    --fixed)        MODE="-F"; shift ;;
    --regex)        MODE="-E"; shift ;;
    --ignore-case)  ICASE="-i"; shift ;;
    --expect-clean) EXPECT_CLEAN=1; shift ;;
    --expect-hit)   EXPECT_HIT=1; shift ;;
    --git-tracked)  GIT_TRACKED=1; shift ;;
    -h|--help)      sed -n '2,60p' "$0"; exit 0 ;;
    --)             shift; while [ $# -gt 0 ]; do PATTERNS+=("$1"); shift; done ;;
    -*)             die "unknown option: $1" ;;
    *)              PATTERNS+=("$1"); shift ;;
  esac
done

# --control is MANDATORY. A sweep without one is exactly the failure mode this
# script exists to prevent, so refusing to run is the whole point.
[ ${#CONTROLS[@]} -gt 0 ] || die "--control <needle-that-must-hit> is REQUIRED. A sweep with no positive control cannot distinguish 'clean' from 'broken'."
[ ${#PATTERNS[@]} -gt 0 ] || die "no patterns given (put them after --)"

if [ ${#PATHS[@]} -eq 0 ]; then
  root="$(git rev-parse --show-toplevel 2>/dev/null || printf '.')"
  PATHS=("$root")
fi
[ -n "$CONTROL_PATH" ] || CONTROL_PATH=""

for p in "${PATTERNS[@]}" "${CONTROLS[@]}"; do
  case "$p" in
    *'\s'*) printf '%s: WARNING: pattern contains \\s, which BSD/macOS grep -E does not support. Use [[:space:]].\n' "$PROG" >&2 ;;
  esac
done

# ---------------------------------------------------------------------------
# run_grep <mode> <pattern> <path...>  -> prints matches, returns grep status
# ALWAYS -a: trap #1 is grep deciding a source file is binary and skipping it.
# ALWAYS `xargs grep`, never `xargs rg`: trap #2 is rg being a shell function
# that does not survive xargs and silently matches nothing.
#
# NEVER add -I. This was written with -I ("skip binary files") for speed and the
# script's OWN positive control caught it: -I overrides -a and re-creates trap
# #1 exactly — a source file with one stray NUL byte is skipped in silence. The
# noise from treating a real binary as text is the price of never lying about a
# clean tree, and it is the right price.
# ---------------------------------------------------------------------------
run_grep() {
  local mode="$1"; shift
  local pat="$1"; shift
  if [ "$GIT_TRACKED" -eq 1 ]; then
    git ls-files -z -- "$@" \
      | xargs -0 grep -a -n $ICASE "$mode" -e "$pat" -- 2>/dev/null
  else
    grep -a -r -n $ICASE "$mode" -e "$pat" -- "$@" 2>/dev/null
  fi
}

# ---------------------------------------------------------------------------
# STEP 1 — POSITIVE CONTROL. Runs FIRST and gates everything after it.
# ---------------------------------------------------------------------------
control_failed=0
if [ -n "$CONTROL_PATH" ]; then CPATHS=("$CONTROL_PATH"); else CPATHS=("${PATHS[@]}"); fi

for c in "${CONTROLS[@]}"; do
  n="$(run_grep "$MODE" "$c" "${CPATHS[@]}" | wc -l | tr -d ' ')"
  if [ "${n:-0}" -gt 0 ]; then
    printf 'CONTROL  OK    %s hit(s)   %s\n' "$n" "$c"
  else
    printf 'CONTROL  MISS  0 hit(s)   %s\n' "$c" >&2
    control_failed=1
  fi
done

if [ "$control_failed" -ne 0 ]; then
  cat >&2 <<'EOF'

*** SWEEP ABORTED — POSITIVE CONTROL MISSED ***
The control needle was not found, so this sweep's machinery is not working.
Any "clean" result from this run is VOID and must not be reported as clean.
Check: is the path right? is the needle really present? did a shell function
(rg), a binary-misdetect (missing -a), or a \s in an ERE eat the match?
EOF
  exit 2
fi

# ---------------------------------------------------------------------------
# STEP 2 — the real sweep. Only reached once the machinery is proven live.
# ---------------------------------------------------------------------------
any_hit=0
any_miss=0

for pat in "${PATTERNS[@]}"; do
  out="$(run_grep "$MODE" "$pat" "${PATHS[@]}")"
  n="$(printf '%s' "$out" | grep -a -c . || true)"
  n="${n:-0}"
  if [ "$n" -gt 0 ]; then
    any_hit=1
    printf 'SWEEP    HIT   %s match(es)  %s\n' "$n" "$pat"
    printf '%s\n' "$out" | head -n "$MAXLINES" | sed 's/^/    /'
    [ "$n" -gt "$MAXLINES" ] && printf '    ... (%s more, use --max)\n' "$((n - MAXLINES))"
  else
    any_miss=1
    printf 'SWEEP    CLEAN 0 match(es)  %s\n' "$pat"
  fi
done

if [ "$EXPECT_CLEAN" -eq 1 ] && [ "$any_hit" -eq 1 ]; then
  printf '\n%s: FAIL — --expect-clean but at least one pattern matched.\n' "$PROG" >&2
  exit 3
fi
if [ "$EXPECT_HIT" -eq 1 ] && [ "$any_miss" -eq 1 ]; then
  printf '\n%s: FAIL — --expect-hit but at least one pattern did not match.\n' "$PROG" >&2
  exit 3
fi

exit 0
