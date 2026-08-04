#!/usr/bin/env bash
# Fast staged-content guard: block smoketest sources; block known fixture
# strings in anything being committed.
#
# This repo is PUBLIC. The guard exists so real personal names, real
# organisations, and real project names cannot reach a public commit.
set -euo pipefail

blocked=0
warned=0

# Anchor the needle paths on THIS SCRIPT's directory, not on
# `git rev-parse --show-toplevel`. The toplevel is resolved from the current
# working directory, so invoking the guard from inside a different repo (or
# from a submodule/worktree) made it look for the needle list in that other
# repo and come up empty. Combined with fail-closed that is merely noisy, but
# the needle list lives next to the script by construction — use that.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
NEEDLE_FILE="$SCRIPT_DIR/.sensitive-needles"
NEEDLE_EXAMPLE="$SCRIPT_DIR/.sensitive-needles.example"

# ---------------------------------------------------------------------------
# Needle list: loaded from an UNTRACKED file, never inlined here.
#
# WHY NOT INLINE: a curated, labelled list of "the strings this project
# considers sensitive" IS a disclosure of those strings. Publishing the
# denylist in a public repo leaks exactly the names the denylist exists to
# protect. scripts/.sensitive-needles is gitignored; the committed
# scripts/.sensitive-needles.example carries SYNTHETIC entries that document
# the format only.
#
# WHY NOT HASHES: do not "improve" this by storing hashes of the needles.
# Matching below is substring + case-INSENSITIVE (grep -Fi), because these
# names appear in the tree in mangled forms — case-folded and space-stripped
# inside larger tokens (e.g. a synthetic "exampleorgname" glued into a query
# fixture id), embedded in JSON string values, and split across identifier
# casings. A hash
# can only be compared for whole-string exact equality: it cannot do substring
# matching, cannot do case-insensitive matching, and cannot survive a diacritic
# or spelling variant. Hashing would turn this guard into something that
# silently passes on precisely the variants that matter, which is worse than no
# guard at all. Keep the needles as plaintext in an untracked file.
#
# NOTE (accuracy): matching is case-insensitive but NOT diacritic-folded.
# grep -Fi will NOT match "Grunwald" against a needle "Grünwald". List BOTH
# spellings of any name that has a diacritic variant. See
# scripts/.sensitive-needles.example.
# ---------------------------------------------------------------------------

# FAIL CLOSED. A guard that silently passes when it cannot find its list is
# worse than no guard: it produces a green run and false confidence at exactly
# the moment it is blind. We refuse the commit rather than warn, because a
# warning on a public-repo data-leak control is a warning everyone learns to
# scroll past. The remedy is one command and it is printed below; the
# deliberate-exception path (--no-verify) still exists.
if [[ ! -f "$NEEDLE_FILE" ]]; then
  echo "pre-commit-guard: REFUSING — needle list not found: $NEEDLE_FILE" >&2
  echo "  The guard cannot verify this commit without its list, so it fails closed." >&2
  echo "  Fix: cp scripts/.sensitive-needles.example scripts/.sensitive-needles" >&2
  echo "       then add the real strings (the file is gitignored)." >&2
  echo "  Deliberate exception: git commit --no-verify" >&2
  exit 1
fi

SENSITIVE_FIXTURES=()
while IFS= read -r line || [[ -n "$line" ]]; do
  # Strip trailing CR (needle file edited on Windows), skip blanks + comments.
  line="${line%$'\r'}"
  [[ -z "$line" ]] && continue
  [[ "$line" == \#* ]] && continue
  SENSITIVE_FIXTURES+=("$line")
done < "$NEEDLE_FILE"

if (( ${#SENSITIVE_FIXTURES[@]} == 0 )); then
  echo "pre-commit-guard: REFUSING — needle list is empty: $NEEDLE_FILE" >&2
  echo "  An empty list means zero protection. Fails closed for the same reason" >&2
  echo "  a missing list does. Populate it (see $NEEDLE_EXAMPLE)." >&2
  echo "  Deliberate exception: git commit --no-verify" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# SKIP LIST — deny-by-default, so this is the ONLY way a textual staged file
# escapes the scan.
#
# Entries are matched against the BASENAME, EXACTLY. Deliberately not globs:
# a glob skip (`*.lock`, `*.min.js`) can be satisfied by *choosing a filename*,
# which turns the skip list back into the extension allowlist this guard was
# rewritten to remove. An exact basename is a named, reviewed exemption — you
# cannot slip a file past it by picking an extension, only by naming your file
# `pnpm-lock.yaml`.
#
# Everything else textual is scanned. Binary content is detected from the blob
# (NUL byte in the first 8000 bytes, the same rule git uses) and skipped
# without error — extensions are never trusted for that decision.
#
# Adding an entry here is a deliberate act: it removes a file from public-leak
# protection permanently. Machine-generated dependency graphs only.
# ---------------------------------------------------------------------------
SKIP_BASENAMES=(
  "pnpm-lock.yaml"
  "package-lock.json"
  "yarn.lock"
  "Cargo.lock"
)

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "pre-commit-guard: REFUSING — not inside a git repository." >&2
  exit 1
fi

# Blobs are dumped here and scanned from disk. Reasons this is a file and not a
# pipeline: (1) the blob is grepped once per needle, (2) `git cat-file | grep`
# inside a loop swallows the exit status in ways that have already produced a
# silent false negative in this repo's audit history.
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pre-commit-guard.XXXXXX")"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT
BLOB="$WORK_DIR/staged-blob"

while IFS= read -r -d '' path; do
  [[ -z "$path" ]] && continue

  case "$path" in
    apps/desktop-sidecar/src/smoketest.ts|\
    apps/desktop-sidecar/src/smoketest-brain.ts|\
    apps/desktop-sidecar/src/smoketest-license.ts|\
    apps/desktop-sidecar/dist/smoketest.js|\
    apps/desktop-sidecar/dist/smoketest-brain.js|\
    apps/desktop-sidecar/dist/smoketest-license.js)
      echo "pre-commit-guard: BLOCKED — do not commit smoketest artifacts: $path" >&2
      echo "  Smoke tests are local-only (see CLAUDE.md). Keep them gitignored." >&2
      blocked=1
      ;;
    scripts/.sensitive-needles)
      # The needle list is the sensitive data. It is gitignored, but `git add -f`
      # stages ignored files, so name it explicitly rather than relying on the
      # content scan below.
      echo "pre-commit-guard: BLOCKED — never commit the needle list: $path" >&2
      echo "  It is the denylist of real names; committing it publishes them." >&2
      echo "  Commit scripts/.sensitive-needles.example instead (synthetic)." >&2
      blocked=1
      ;;
  esac

  # -------------------------------------------------------------------------
  # SCAN THE INDEX, NOT THE WORKING TREE.
  #
  # The previous version read the worktree file at $path. A commit does not
  # commit the worktree — it commits the index. Two everyday sequences made the
  # guard pass on a leak that was already staged:
  #
  #   (i)  stage a file, then clean the worktree copy. The staged blob still
  #        holds the needle; the worktree no longer does; the guard read the
  #        clean copy and exited 0.
  #   (ii) stage a file, then delete it from the worktree. `[[ -f $path ]]`
  #        was false, so the path was skipped entirely and the guard exited 0.
  #
  # This is not an exotic attack. `git add -p` followed by any further edit is
  # exactly sequence (i), and it is normal workflow. Read the staged blob.
  # -------------------------------------------------------------------------
  if ! git cat-file blob ":0:$path" > "$BLOB" 2>/dev/null; then
    mode="$(git ls-files --stage -- "$path" 2>/dev/null | awk 'NR==1{print $1}')"
    if [[ "$mode" == "160000" ]]; then
      # Submodule gitlink: the index entry is a commit id, not file content.
      # Nothing to scan; the submodule's own hook guards its contents.
      continue
    fi
    # Fail closed, exactly like a missing needle list: we cannot see what is
    # being committed, so we do not pretend it is clean.
    echo "pre-commit-guard: REFUSING — cannot read staged content for: $path" >&2
    echo "  The index entry could not be resolved (unmerged path?). Resolve it" >&2
    echo "  and retry; the guard will not pass a file it cannot read." >&2
    blocked=1
    continue
  fi

  base="${path##*/}"

  skip_reason=""
  for skipname in "${SKIP_BASENAMES[@]}"; do
    if [[ "$base" == "$skipname" ]]; then
      skip_reason="skip-list"
      break
    fi
  done

  if [[ -z "$skip_reason" ]]; then
    # BINARY DETECTION FROM CONTENT, NOT FROM THE EXTENSION.
    # The extension allowlist this replaced silently skipped every type it did
    # not know about (.astro .patch .service .command .bat .lock .sha256
    # .mdown .rst .tex .log .gll all sailed through with a live needle). A new
    # file type must be protected by default, so the only content-based escape
    # is "this blob has a NUL byte in its first 8000 bytes" — the same rule git
    # itself uses to call a blob binary.
    head_bytes="$(head -c 8000 "$BLOB" | wc -c | tr -d ' ')"
    text_bytes="$(head -c 8000 "$BLOB" | tr -d '\000' | wc -c | tr -d ' ')"
    if [[ "$head_bytes" != "$text_bytes" ]]; then
      skip_reason="binary"
    fi
  fi

  if [[ -z "$skip_reason" ]]; then
    for needle in "${SENSITIVE_FIXTURES[@]}"; do
      # `command grep` bypasses any interactive grep wrapper/alias that honours
      # .gitignore or skips binaries — a wrapper silently returning zero hits is
      # how this class of check produces false negatives. -a forces text mode so
      # a stray high byte cannot make grep declare the blob binary and report
      # nothing.
      if command grep -aFiq -- "$needle" "$BLOB" 2>/dev/null; then
        echo "pre-commit-guard: BLOCKED — staged file contains personal fixture data: $path (matched: $needle)" >&2
        warned=1
      fi
    done
  fi
done < <(git diff --cached --name-only -z --diff-filter=ACMR)

if (( blocked )); then
  exit 1
fi

if (( warned )); then
  echo "pre-commit-guard: replace the matched fixture(s) with synthetic placeholders — this repo is PUBLIC." >&2
  echo "  Real personal names/projects must not reach app source, docs, or tests." >&2
  echo "  Deliberate exception: git commit --no-verify" >&2
  exit 1
fi

exit 0
