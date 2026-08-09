#!/usr/bin/env bash
# Portable supervisor entry: map a short intent string to pipeline CLI.
# See docs/supervisor.md. No second scheduler — exits when the pipeline process exits.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: run-intent.sh <intent-string>

Examples:
  run-intent.sh 'single 42'
  run-intent.sh 'train issues 10,11,12'
  run-intent.sh 'train milestone v1.34.0'
  run-intent.sh 'train issues 10 11 --merge'   # only if ALLOW_MERGE=1

Environment:
  REPO_DIR      Working tree for the target repo (required)
  PIPELINE      pipeline launcher (default: pipeline)
  ALLOW_MERGE   set to 1 to permit --merge / merge intents
  EXTRA_ARGS    extra args appended to every pipeline invocation
EOF
}

if [[ $# -lt 1 ]]; then
  usage
  exit 2
fi

INTENT=$*
REPO_DIR=${REPO_DIR:-}
PIPELINE=${PIPELINE:-pipeline}
ALLOW_MERGE=${ALLOW_MERGE:-0}
EXTRA_ARGS=${EXTRA_ARGS:-}

if [[ -z "$REPO_DIR" ]]; then
  echo "run-intent: REPO_DIR is required" >&2
  exit 2
fi
if [[ ! -d "$REPO_DIR" ]]; then
  echo "run-intent: REPO_DIR is not a directory: $REPO_DIR" >&2
  exit 2
fi

cd "$REPO_DIR"

# Normalize whitespace
INTENT=$(echo "$INTENT" | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//')
LOWER=$(echo "$INTENT" | tr '[:upper:]' '[:lower:]')

want_merge=0
if [[ "$LOWER" == *"--merge"* ]] || [[ "$LOWER" == *" and merge"* ]] || [[ "$LOWER" == *" integrate"* ]]; then
  want_merge=1
fi
if [[ "$want_merge" -eq 1 && "$ALLOW_MERGE" != "1" ]]; then
  echo "run-intent: merge requested but ALLOW_MERGE is not 1 — refusing" >&2
  exit 2
fi

merge_flag=()
if [[ "$want_merge" -eq 1 ]]; then
  merge_flag=(--merge)
fi

# shellcheck disable=SC2206
extra=( $EXTRA_ARGS )

run_train_issues() {
  local list=$1
  # Accept "10 11 12" or "10,11,12"
  list=$(echo "$list" | tr ' ' ',' | sed 's/,,*/,/g; s/^,//; s/,$//')
  exec "$PIPELINE" train --issues "$list" "${merge_flag[@]}" --json "${extra[@]}"
}

run_train_milestone() {
  local ms=$1
  exec "$PIPELINE" train --milestone "$ms" "${merge_flag[@]}" --json "${extra[@]}"
}

case "$LOWER" in
  single\ [1-9]*|do\ #[1-9]*|pipeline\ [1-9]*)
    num=$(echo "$INTENT" | grep -oE '[1-9][0-9]*' | head -1)
    exec "$PIPELINE" single "$num" "${extra[@]}"
    ;;
  train\ issues\ *|train\ issue\ *|issues\ *)
    rest=${INTENT#*[Ii][Ss][Ss][Uu][Ee][Ss] }
    rest=${rest#*[Ii][Ss][Ss][Uu][Ee] }
    rest=$(echo "$rest" | sed 's/[Aa][Nn][Dd] [Mm][Ee][Rr][Gg][Ee]//g; s/--merge//g')
    run_train_issues "$rest"
    ;;
  train\ milestone\ *|milestone\ *)
    rest=${INTENT#*[Mm][Ii][Ll][Ee][Ss][Tt][Oo][Nn][Ee] }
    rest=$(echo "$rest" | sed 's/[Aa][Nn][Dd] [Mm][Ee][Rr][Gg][Ee]//g; s/--merge//g; s/^ *//; s/ *$//')
    run_train_milestone "$rest"
    ;;
  train\ [1-9]*|train\ #[1-9]*)
    rest=$(echo "$INTENT" | sed 's/^[Tt][Rr][Aa][Ii][Nn] //; s/#//g; s/[Aa][Nn][Dd] [Mm][Ee][Rr][Gg][Ee]//g; s/--merge//g')
    run_train_issues "$rest"
    ;;
  status*|train\ status*)
    echo "run-intent: no durable outer status store — re-run train with --json or use pipeline status <N> / loop logs" >&2
    exit 2
    ;;
  *)
    echo "run-intent: unrecognized intent: $INTENT" >&2
    usage
    exit 2
    ;;
esac
