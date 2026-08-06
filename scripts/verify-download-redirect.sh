#!/usr/bin/env bash
#
# Release guard: verify the OUTCOME, not the mechanism.
#
# WHY THIS EXISTS
# ---------------
# /download/<platform> is served by apps/docs/functions/download/[platform].ts,
# which resolves `CURRENT_VERSION || FALLBACK_VERSION`. CURRENT_VERSION is a
# Cloudflare Pages env var written by release.yml's update-cloudflare-* jobs.
#
# Cloudflare Pages captures env vars at deployment START, not at deployment end.
# On the v1.34.0 and v1.35.0 releases the Pages deployment completed 72-78s
# AFTER the env-var PATCH. Whether a given deployment STARTED before or after
# the PATCH is not observable from GitHub. On 2026-08-05 ~11:45Z the live page
# served v1.28.0 (the FALLBACK) even though v1.34.0's PATCH had reported success
# at 00:11:22Z and a Pages deployment had succeeded at 00:12:40Z.
#
# Two causes fit that evidence equally (deployment raced ahead of the PATCH, or
# the PATCH silently no-op'd) and they cannot be told apart without CF_API_TOKEN.
# So this guard does not try. It checks the thing the user actually experiences:
# after the deploy, does the LIVE endpoint redirect to the version just built?
#
# SUBCOMMANDS
#   require-jq
#       Fail loudly if jq is missing rather than silently skipping API checks.
#
#   check-api <http_code> <body_file> <label>
#       Assert a Cloudflare API call succeeded. The Cloudflare API returns
#       HTTP 200 with {"success": false, "errors": [...]} on many failures, so
#       `curl --fail` alone would NOT catch it. Both conditions are required:
#       2xx status AND .success == true. Prints .errors on failure.
#
#   verify <expected_version> <platform> [platform...]
#       Poll the live endpoints (NO redirect following) and assert each
#       Location header carries <expected_version> as the release path segment.
#       Retries with a fixed interval; see budget justification below.
#
# TESTABILITY (this is deliberate)
# --------------------------------
# All decision logic lives here, not inlined in release.yml, so it can be
# exercised with canned inputs, no network and no credentials. See
# scripts/test-verify-download-redirect.sh.
#
#   FETCH_LOCATION_CMD   Command invoked as `$FETCH_LOCATION_CMD <url>`; must
#                        print the Location header value on stdout. Defaults to
#                        a curl one-shot. Tests override it with a fake.
#   VERIFY_BASE_URL      Default https://graphnosis.com
#   VERIFY_ATTEMPTS      Default 40
#   VERIFY_INTERVAL      Default 15 (seconds between attempts)
#   VERIFY_INITIAL_WAIT  Default 20 (seconds before the first attempt)
#
# RETRY BUDGET
# ------------
# Measured deployment time on v1.34.0 and v1.35.0: 72-78s from PATCH to Pages
# deployment complete, plus edge propagation. A single immediate check would be
# a guaranteed false failure — at t+0 the redeploy has not even started.
#   20s initial wait + 40 attempts x 15s = 620s (~10 min) total budget.
# That is ~8x the measured worst case, so a green result would require an 8x
# regression to become a false failure. The full 10 minutes is only ever spent
# on a genuine failure (a deployment that captured the OLD env var never
# converges — waiting longer cannot help it), which is an acceptable once-per-
# release cost for catching a silently-stale download link.

set -euo pipefail

BASE_URL="${VERIFY_BASE_URL:-https://graphnosis.com}"
ATTEMPTS="${VERIFY_ATTEMPTS:-40}"
INTERVAL="${VERIFY_INTERVAL:-15}"
INITIAL_WAIT="${VERIFY_INITIAL_WAIT:-20}"

die() {
  echo "::error::$*" >&2
  exit 1
}

# ---------------------------------------------------------------- require-jq
cmd_require_jq() {
  command -v jq >/dev/null 2>&1 \
    || die "jq is not installed on this runner. The Cloudflare API response checks require it."
  echo "jq present: $(jq --version)"
}

# ---------------------------------------------------------------- check-api
# Usage: check-api <http_code> <body_file> <label>
cmd_check_api() {
  local code="${1:?http_code required}"
  local body_file="${2:?body_file required}"
  local label="${3:-Cloudflare API call}"

  if [ ! -f "$body_file" ]; then
    die "$label: response body file '$body_file' does not exist."
  fi

  # Condition 1: HTTP status must be 2xx.
  case "$code" in
    2??) ;;
    *)
      echo "----- response body -----" >&2
      cat "$body_file" >&2
      echo "-------------------------" >&2
      die "$label: HTTP $code (expected 2xx)."
      ;;
  esac

  # Condition 2: the Cloudflare envelope must report success.
  # HTTP 200 + {"success": false} is a real and common Cloudflare failure mode;
  # this is exactly what `curl --fail` would have let through.
  local ok
  ok="$(jq -r 'if type == "object" then (.success // "missing") else "not-an-object" end' \
        <"$body_file" 2>/dev/null || echo "unparseable")"

  if [ "$ok" != "true" ]; then
    echo "::group::$label — Cloudflare API reported failure" >&2
    echo "HTTP status : $code" >&2
    echo ".success    : $ok" >&2
    echo ".errors     :" >&2
    jq -r '.errors // "(no .errors field)"' <"$body_file" >&2 2>/dev/null \
      || cat "$body_file" >&2
    echo "::endgroup::" >&2
    die "$label: HTTP $code but the Cloudflare API did not report success (.success=$ok). See .errors above."
  fi

  echo "OK  $label: HTTP $code, .success=true"
}

# ---------------------------------------------------------------- verify
# Default fetcher. Deliberately does NOT follow redirects (-L is absent): we
# want to read the Location header the Function emits, not chase it to GitHub
# (which would 404 for a not-yet-uploaded asset and confuse the diagnosis).
default_fetch_location() {
  local url="$1"
  curl -sS -o /dev/null -D - --max-time 20 "$url" 2>/dev/null \
    | tr -d '\r' \
    | awk 'tolower($1) == "location:" { print $2 }' \
    | tail -n 1
}

fetch_location() {
  local url="$1"
  if [ -n "${FETCH_LOCATION_CMD:-}" ]; then
    # shellcheck disable=SC2086
    $FETCH_LOCATION_CMD "$url"
  else
    default_fetch_location "$url"
  fi
}

# Extract the release path segment from a GitHub release-asset URL.
# .../releases/download/v1.35.0/Graphnosis_1.35.0_aarch64.dmg  ->  v1.35.0
# Anything that is not shaped like a release-asset URL yields the empty string,
# which is treated as a mismatch (e.g. the Function fell through to /download).
extract_version() {
  local url="$1"
  printf '%s' "$url" \
    | sed -n 's#^.*/releases/download/\([^/]*\)/.*$#\1#p'
}

cmd_verify() {
  local expected="${1:?expected_version required}"
  shift
  [ "$#" -ge 1 ] || die "verify: at least one platform is required"
  local platforms=("$@")

  echo "Verifying live download redirects."
  echo "  base        : $BASE_URL"
  echo "  expected    : $expected"
  echo "  platforms   : ${platforms[*]}"
  echo "  budget      : ${INITIAL_WAIT}s wait + ${ATTEMPTS} attempts x ${INTERVAL}s"
  echo

  if [ "$INITIAL_WAIT" -gt 0 ]; then
    echo "Waiting ${INITIAL_WAIT}s for the Cloudflare Pages deployment to start..."
    sleep "$INITIAL_WAIT"
  fi

  local attempt=1
  # Last-seen state, kept across attempts so the failure message can report
  # what was ACTUALLY served rather than "assertion failed".
  local -a last_url last_ver
  local i
  for ((i = 0; i < ${#platforms[@]}; i++)); do
    last_url[i]="(never fetched)"
    last_ver[i]="(none)"
  done

  while [ "$attempt" -le "$ATTEMPTS" ]; do
    local all_ok=1
    for ((i = 0; i < ${#platforms[@]}; i++)); do
      local p="${platforms[i]}"
      local url loc ver
      url="${BASE_URL}/download/${p}"
      loc="$(fetch_location "$url" || true)"
      ver="$(extract_version "$loc")"
      last_url[i]="${loc:-(no Location header)}"
      last_ver[i]="${ver:-(none)}"
      if [ "$ver" != "$expected" ]; then
        all_ok=0
      fi
    done

    if [ "$all_ok" -eq 1 ]; then
      echo "attempt ${attempt}/${ATTEMPTS}: all platforms serve ${expected}"
      echo
      for ((i = 0; i < ${#platforms[@]}; i++)); do
        echo "  OK  /download/${platforms[i]} -> ${last_url[i]}"
      done
      echo
      echo "Live endpoints confirmed on ${expected}."
      return 0
    fi

    echo "attempt ${attempt}/${ATTEMPTS}: not converged yet"
    for ((i = 0; i < ${#platforms[@]}; i++)); do
      local mark="ok  "
      [ "${last_ver[i]}" != "$expected" ] && mark="WAIT"
      echo "  ${mark} /download/${platforms[i]} -> serving ${last_ver[i]}"
    done

    attempt=$((attempt + 1))
    if [ "$attempt" -le "$ATTEMPTS" ] && [ "$INTERVAL" -gt 0 ]; then
      sleep "$INTERVAL"
    fi
  done

  # ------------------------------------------------------------------ FAILURE
  # Print the diagnosis, not just the assertion.
  {
    echo
    echo "================= DOWNLOAD REDIRECT VERIFICATION FAILED ================="
    echo
    echo "  EXPECTED version : ${expected}"
    echo
    echo "  ACTUALLY SERVED  :"
    for ((i = 0; i < ${#platforms[@]}; i++)); do
      printf '    %-28s served %-12s  %s\n' \
        "${BASE_URL}/download/${platforms[i]}" \
        "${last_ver[i]}" \
        "${last_url[i]}"
    done
    echo
    echo "  Budget exhausted: ${ATTEMPTS} attempts over ~$((INITIAL_WAIT + ATTEMPTS * INTERVAL))s."
    echo
    echo "  WHAT THIS MEANS"
    echo "    The Cloudflare Pages env var CURRENT_VERSION was NOT in effect on the"
    echo "    live deployment. Pages captures env vars at deployment START, so a"
    echo "    deployment that began before the PATCH landed will serve the OLD value"
    echo "    (or, if CURRENT_VERSION is unset entirely, FALLBACK_VERSION from"
    echo "    apps/docs/functions/download/[platform].ts). Waiting longer does not"
    echo "    fix this — that deployment will never pick up the new value."
    echo
    echo "  HOW TO FIX, RIGHT NOW"
    echo "    1. Cloudflare dashboard -> Pages -> the project -> Settings ->"
    echo "       Environment variables (Production). Confirm CURRENT_VERSION is"
    echo "       ${expected}. If it is not, the PATCH is the problem."
    echo "    2. If it IS ${expected}, the env var is fine and the DEPLOYMENT raced."
    echo "       Trigger a fresh production deployment (Deployments -> Retry"
    echo "       deployment) and re-run this job."
    echo "    3. Until one of those lands, every /download/* link on the site points"
    echo "       at the wrong release."
    echo "========================================================================"
  } >&2
  exit 1
}

# ---------------------------------------------------------------- dispatch
main() {
  local sub="${1:-}"
  [ "$#" -ge 1 ] && shift
  case "$sub" in
    require-jq) cmd_require_jq "$@" ;;
    check-api)  cmd_check_api "$@" ;;
    verify)     cmd_verify "$@" ;;
    *)
      echo "usage: $0 {require-jq|check-api <http_code> <body_file> <label>|verify <version> <platform...>}" >&2
      exit 2
      ;;
  esac
}

main "$@"
