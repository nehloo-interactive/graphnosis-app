#!/usr/bin/env bash
#
# Mutation test for scripts/verify-download-redirect.sh.
#
# A guard that cannot be SHOWN to fail is the exact defect being fixed here: the
# three Cloudflare API calls in release.yml were `curl -s` with no --fail and no
# response check, so they were structurally incapable of failing. This test
# feeds the decision logic canned inputs — NO network, NO credentials — and
# asserts the exit status for each case.
#
#   a) Location carries the expected version          -> exit 0
#   b) Location carries an OLDER version (the bug)    -> exit non-zero
#   c) API responds HTTP 200 with {"success": false}  -> exit non-zero
#   d) endpoint never converges within the budget     -> exit non-zero
#
# Plus regression cases for the failure modes that a naive substring check or a
# `curl --fail`-only check would let through.
#
# Run:  bash scripts/test-verify-download-redirect.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# GUARD_UNDER_TEST lets a mutant copy be substituted, so this suite can be shown
# to go RED against a deliberately broken guard. A test that only ever passes is
# no better than the unchecked `curl -s` it replaces.
GUARD="${GUARD_UNDER_TEST:-$HERE/verify-download-redirect.sh}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0

# --------------------------------------------------------------- fake fetcher
# Writes a fetcher that prints a Location header from a canned table.
# Table format, one per line:  <platform> <location-url>
# A platform absent from the table yields an empty Location.
# If SEQ_DIR is set, the fetcher walks a sequence of tables (step-1, step-2, ...)
# so "converges on attempt N" and "never converges" can both be simulated.
make_fetcher() {
  local path="$1"; shift
  cat >"$path" <<'FETCHER'
#!/usr/bin/env bash
url="$1"
platform="${url##*/download/}"
table="$TABLE"
if [ -n "${SEQ_DIR:-}" ]; then
  n="$(cat "$SEQ_DIR/counter" 2>/dev/null || echo 0)"
  # one tick per full sweep of all platforms
  hits="$(cat "$SEQ_DIR/hits" 2>/dev/null || echo 0)"
  hits=$((hits + 1))
  echo "$hits" > "$SEQ_DIR/hits"
  if [ "$hits" -ge "${SEQ_PLATFORMS:-1}" ]; then
    echo 0 > "$SEQ_DIR/hits"
    echo $((n + 1)) > "$SEQ_DIR/counter"
  fi
  step="$SEQ_DIR/step-$n"
  [ -f "$step" ] || step="$SEQ_DIR/step-last"
  table="$step"
fi
awk -v p="$platform" '$1 == p { print $2 }' "$table"
FETCHER
  chmod +x "$path"
}

# ----------------------------------------------------------------- assertions
expect_exit() {
  local want="$1" name="$2"; shift 2
  local out rc
  out="$("$@" 2>&1)"; rc=$?
  if [ "$want" = "nonzero" ]; then
    if [ "$rc" -ne 0 ]; then
      printf 'PASS  %-58s exit=%s\n' "$name" "$rc"
      PASS=$((PASS + 1))
    else
      printf 'FAIL  %-58s exit=0 (expected non-zero)\n' "$name"
      echo "$out" | sed 's/^/        | /'
      FAIL=$((FAIL + 1))
    fi
  else
    if [ "$rc" -eq "$want" ]; then
      printf 'PASS  %-58s exit=%s\n' "$name" "$rc"
      PASS=$((PASS + 1))
    else
      printf 'FAIL  %-58s exit=%s (expected %s)\n' "$name" "$rc" "$want"
      echo "$out" | sed 's/^/        | /'
      FAIL=$((FAIL + 1))
    fi
  fi
  LAST_OUT="$out"
}

# Assert the failure output actually contains the diagnosis, not "assertion failed".
expect_output_contains() {
  local needle="$1" name="$2"
  if printf '%s' "$LAST_OUT" | grep -qF -- "$needle"; then
    printf 'PASS  %-58s (output contains %s)\n' "$name" "\"$needle\""
    PASS=$((PASS + 1))
  else
    printf 'FAIL  %-58s (output MISSING %s)\n' "$name" "\"$needle\""
    printf '%s' "$LAST_OUT" | sed 's/^/        | /'
    FAIL=$((FAIL + 1))
  fi
}

GH_URL='https://github.com/nehloo-interactive/graphnosis-app/releases/download'

echo "=========================================================================="
echo " mutation test: scripts/verify-download-redirect.sh"
echo " no network, no credentials — canned inputs only"
echo "=========================================================================="
echo

# ==========================================================================
# CASE (a) — Location carries the expected version -> exit 0
# ==========================================================================
cat >"$WORK/table-good" <<EOF
mac        $GH_URL/v1.35.0/Graphnosis_1.35.0_aarch64.dmg
win        $GH_URL/v1.35.0/Graphnosis_1.35.0_x64_en-US.msi
linux      $GH_URL/v1.35.0/Graphnosis_1.35.0_amd64.AppImage
linux-deb  $GH_URL/v1.35.0/Graphnosis_1.35.0_amd64.deb
EOF
make_fetcher "$WORK/fetch"

export FETCH_LOCATION_CMD="$WORK/fetch"
export VERIFY_INITIAL_WAIT=0
export VERIFY_INTERVAL=0
export VERIFY_ATTEMPTS=3
export VERIFY_BASE_URL="https://graphnosis.com"

echo "--- CASE (a) expected version served -> expect exit 0"
TABLE="$WORK/table-good" expect_exit 0 "a) all four platforms serve v1.35.0" \
  bash "$GUARD" verify v1.35.0 mac win linux linux-deb
echo

# ==========================================================================
# CASE (b) — Location carries an OLDER version -> exit non-zero
#            This is the real 2026-08-05 bug: live served v1.28.0 (FALLBACK).
# ==========================================================================
cat >"$WORK/table-stale" <<EOF
mac        $GH_URL/v1.28.0/Graphnosis_1.28.0_aarch64.dmg
win        $GH_URL/v1.28.0/Graphnosis_1.28.0_x64_en-US.msi
linux      $GH_URL/v1.28.0/Graphnosis_1.28.0_amd64.AppImage
linux-deb  $GH_URL/v1.28.0/Graphnosis_1.28.0_amd64.deb
EOF

echo "--- CASE (b) OLDER version served (the real bug) -> expect non-zero"
TABLE="$WORK/table-stale" expect_exit nonzero "b) live serves v1.28.0, expected v1.35.0" \
  bash "$GUARD" verify v1.35.0 mac win linux linux-deb
expect_output_contains "EXPECTED version : v1.35.0"                  "b) prints EXPECTED version"
expect_output_contains "Graphnosis_1.28.0_aarch64.dmg"               "b) prints URL actually served"
expect_output_contains "HOW TO FIX, RIGHT NOW"                       "b) prints a diagnosis"
echo

# b2) only ONE platform stale — must still fail (the win-PATCH-drops-env case)
cat >"$WORK/table-partial" <<EOF
mac        $GH_URL/v1.35.0/Graphnosis_1.35.0_aarch64.dmg
win        $GH_URL/v1.28.0/Graphnosis_1.28.0_x64_en-US.msi
linux      $GH_URL/v1.35.0/Graphnosis_1.35.0_amd64.AppImage
linux-deb  $GH_URL/v1.35.0/Graphnosis_1.35.0_amd64.deb
EOF
echo "--- CASE (b2) ONE platform stale -> expect non-zero"
TABLE="$WORK/table-partial" expect_exit nonzero "b2) only /download/win is stale" \
  bash "$GUARD" verify v1.35.0 mac win linux linux-deb
echo

# ==========================================================================
# CASE (c) — Cloudflare API: HTTP 200 with {"success": false} -> non-zero
#            `curl --fail` would NOT have caught this.
# ==========================================================================
echo '{"success": false, "errors": [{"code": 10000, "message": "Authentication error"}], "result": null}' \
  >"$WORK/api-200-false.json"
echo '{"success": true, "errors": [], "result": {"id": "abc"}}' \
  >"$WORK/api-200-true.json"
echo '{"success": false, "errors": [{"code": 8000000, "message": "Internal error"}]}' \
  >"$WORK/api-500.json"
printf 'upstream connect error, not json at all' >"$WORK/api-garbage.txt"

echo "--- CASE (c) API envelope checks"
expect_exit nonzero "c) HTTP 200 + {\"success\": false}" \
  bash "$GUARD" check-api 200 "$WORK/api-200-false.json" "PATCH env vars (mac)"
expect_output_contains "Authentication error"                        "c) prints .errors"
expect_exit 0       "c2) HTTP 200 + {\"success\": true}" \
  bash "$GUARD" check-api 200 "$WORK/api-200-true.json" "PATCH env vars (mac)"
expect_exit nonzero "c3) HTTP 500" \
  bash "$GUARD" check-api 500 "$WORK/api-500.json" "redeploy POST"
expect_exit nonzero "c4) HTTP 200 + unparseable body" \
  bash "$GUARD" check-api 200 "$WORK/api-garbage.txt" "PATCH env vars (win)"
expect_exit nonzero "c5) response body file missing entirely" \
  bash "$GUARD" check-api 200 "$WORK/does-not-exist.json" "redeploy POST"

# c6) Non-2xx status but a success-looking body (edge/proxy 5xx over a stale or
#     cached envelope). This exercises the HTTP-status gate INDEPENDENTLY of the
#     .success gate — without it, deleting the status check goes undetected.
echo '{"success": true, "errors": [], "result": {"id": "stale"}}' >"$WORK/api-502-true.json"
expect_exit nonzero "c6) HTTP 502 + {\"success\": true} body" \
  bash "$GUARD" check-api 502 "$WORK/api-502-true.json" "redeploy POST"

# c7) And the mirror: 2xx with success true is the ONLY passing combination.
expect_exit nonzero "c7) HTTP 301 + {\"success\": true}" \
  bash "$GUARD" check-api 301 "$WORK/api-502-true.json" "PATCH env vars (win)"
echo

# ==========================================================================
# CASE (d) — never converges within the retry budget -> non-zero
#            and it must actually EXHAUST the budget, not bail on attempt 1.
# ==========================================================================
echo "--- CASE (d) never converges within budget -> expect non-zero after N attempts"
TABLE="$WORK/table-stale" expect_exit nonzero "d) 3 attempts, never converges" \
  bash "$GUARD" verify v1.35.0 mac win linux linux-deb
expect_output_contains "attempt 3/3: not converged"                  "d) exhausted all 3 attempts"
expect_output_contains "Budget exhausted"                            "d) reports budget exhaustion"
echo

# d2) converges on attempt 3 of 5 -> exit 0 (proves retry actually retries,
#     i.e. the guard is not a guaranteed false failure at t+0)
SEQ="$WORK/seq"; mkdir -p "$SEQ"
cp "$WORK/table-stale" "$SEQ/step-0"
cp "$WORK/table-stale" "$SEQ/step-1"
cp "$WORK/table-good"  "$SEQ/step-2"
cp "$WORK/table-good"  "$SEQ/step-last"
echo 0 >"$SEQ/counter"; echo 0 >"$SEQ/hits"
echo "--- CASE (d2) converges on attempt 3 of 5 -> expect exit 0"
SEQ_DIR="$SEQ" SEQ_PLATFORMS=4 TABLE="$WORK/table-good" \
  VERIFY_ATTEMPTS=5 expect_exit 0 "d2) stale, stale, then correct -> passes" \
  bash "$GUARD" verify v1.35.0 mac win linux linux-deb
echo

# ==========================================================================
# REGRESSION — failure modes a sloppier implementation would let through
# ==========================================================================
echo "--- REGRESSION cases"

# r1) No Location header at all (Function 500 / origin down).
cat >"$WORK/table-empty" <<EOF
# deliberately empty: fetcher prints nothing
EOF
TABLE="$WORK/table-empty" expect_exit nonzero "r1) no Location header at all" \
  bash "$GUARD" verify v1.35.0 mac

# r2) Redirected to the /download landing page (unknown-platform fallthrough)
#     — not a release-asset URL, so it must NOT be read as a version.
cat >"$WORK/table-landing" <<EOF
mac  https://graphnosis.com/download
EOF
TABLE="$WORK/table-landing" expect_exit nonzero "r2) fell through to /download landing page" \
  bash "$GUARD" verify v1.35.0 mac

# r3) SUBSTRING TRAP: expected v1.3.0, served v1.35.0. A naive
#     `case "$loc" in *"$expected"*)` check would PASS this. It must fail.
cat >"$WORK/table-substr" <<EOF
mac  $GH_URL/v1.35.0/Graphnosis_1.35.0_aarch64.dmg
EOF
TABLE="$WORK/table-substr" expect_exit nonzero "r3) substring trap: v1.3.0 vs served v1.35.0" \
  bash "$GUARD" verify v1.3.0 mac

# r3b) THE substring trap that actually bites: expected v1.35.0, served a
#      PRERELEASE segment v1.35.0-rc1. "v1.35.0" IS a literal substring of
#      "v1.35.0-rc1", so a `grep -qF "$expected"` implementation passes this
#      wrongly. Exact-segment matching must reject it.
cat >"$WORK/table-prerelease" <<EOF
mac  $GH_URL/v1.35.0-rc1/Graphnosis_1.35.0-rc1_aarch64.dmg
EOF
TABLE="$WORK/table-prerelease" expect_exit nonzero "r3b) substring trap: v1.35.0 vs served v1.35.0-rc1" \
  bash "$GUARD" verify v1.35.0 mac

# r3c) The reverse: releasing a prerelease while stable is live.
cat >"$WORK/table-stable" <<EOF
mac  $GH_URL/v1.35.0/Graphnosis_1.35.0_aarch64.dmg
EOF
TABLE="$WORK/table-stable" expect_exit nonzero "r3c) expected v1.35.0-rc1, served v1.35.0" \
  bash "$GUARD" verify v1.35.0-rc1 mac

# r4) NEWER version served than the one being released — also a mismatch
#     (means a later release's env var is live; the tag being verified is not).
cat >"$WORK/table-newer" <<EOF
mac  $GH_URL/v1.36.0/Graphnosis_1.36.0_aarch64.dmg
EOF
TABLE="$WORK/table-newer" expect_exit nonzero "r4) NEWER version served than expected" \
  bash "$GUARD" verify v1.35.0 mac

# r5) Version segment matches but the asset filename carries a different semver
#     — the guard asserts on the release segment, which is the thing
#     CURRENT_VERSION controls. Documented as PASS on purpose.
cat >"$WORK/table-mixed" <<EOF
mac  $GH_URL/v1.35.0/Graphnosis_1.34.0_aarch64.dmg
EOF
TABLE="$WORK/table-mixed" expect_exit 0 "r5) release segment correct, filename stale (by design)" \
  bash "$GUARD" verify v1.35.0 mac

# r6) Bad usage must not silently succeed.
expect_exit nonzero "r6) verify with no platforms" bash "$GUARD" verify v1.35.0
expect_exit nonzero "r7) unknown subcommand"       bash "$GUARD" frobnicate
echo

echo "=========================================================================="
printf ' RESULT: %d passed, %d failed\n' "$PASS" "$FAIL"
echo "=========================================================================="
[ "$FAIL" -eq 0 ] || exit 1
exit 0
