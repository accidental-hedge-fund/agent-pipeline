#!/usr/bin/env bash
# Observe one exact Pipeline run event stream through the shared material
# filter. The caller must supply the absolute events.jsonl path returned by
# Pipeline; this adapter never searches host-global run directories.
#
#   ship-stage-watch.sh --events-file /absolute/run/events.jsonl \
#     [--label "ship v1.34.0"] [--channel <id>] [--reply-to <event-id>] [--once]
#
# Environment:
#   PIPELINE_MATERIAL_FILTER  installed material-filter.mjs executable
#   SHIP_NOTIFY_BIN           messenger adapter (default: sibling script)
#   SHIP_NOTIFY               0 disables messenger calls (default 1)
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
MATERIAL_FILTER="${PIPELINE_MATERIAL_FILTER:-material-filter.mjs}"
SHIP_NOTIFY_BIN="${SHIP_NOTIFY_BIN:-$SCRIPT_DIR/ship-notify.sh}"
SHIP_NOTIFY="${SHIP_NOTIFY:-1}"

events_file=""
label="pipeline run"
channel=""
reply_to=""
once=0
pid_file=""

usage() {
  cat <<'USAGE'
Usage:
  ship-stage-watch.sh --events-file /absolute/run/events.jsonl \
    [--label "ship vX.Y.Z"] [--channel <id>] [--reply-to <event-id>] \
    [--once] [--pid-file /absolute/watch.pid]

The events file must identify one exact Pipeline run. Follow mode starts at
the current cursor and exits on the completed ship phase. This command does
not discover latest loop or advance runs. Set PIPELINE_MATERIAL_FILTER to the
installed material-filter.mjs executable.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --events-file)
      [[ -n "${2:-}" ]] || { echo "missing value for $1" >&2; exit 2; }
      events_file=$2
      shift 2
      ;;
    --label)
      [[ -n "${2:-}" ]] || { echo "missing value for $1" >&2; exit 2; }
      label=$2
      shift 2
      ;;
    --channel)
      [[ -n "${2:-}" ]] || { echo "missing value for $1" >&2; exit 2; }
      channel=$2
      shift 2
      ;;
    --reply-to)
      [[ -n "${2:-}" ]] || { echo "missing value for $1" >&2; exit 2; }
      reply_to=$2
      shift 2
      ;;
    --once)
      once=1
      shift
      ;;
    --pid-file)
      [[ -n "${2:-}" ]] || { echo "missing value for $1" >&2; exit 2; }
      pid_file=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ -n "$events_file" ]] || { echo "--events-file is required" >&2; exit 2; }
[[ "$events_file" == /* ]] || { echo "--events-file must be an absolute path" >&2; exit 2; }
[[ -z "$channel" ]] || export BUZZ_CHANNEL="$channel"
[[ -z "$reply_to" ]] || export BUZZ_REPLY_TO="$reply_to"

if [[ "$MATERIAL_FILTER" == */* ]]; then
  [[ -x "$MATERIAL_FILTER" ]] || {
    echo "material filter is not executable: $MATERIAL_FILTER" >&2
    exit 2
  }
else
  command -v "$MATERIAL_FILTER" >/dev/null 2>&1 || {
    echo "material filter not found on PATH: $MATERIAL_FILTER" >&2
    exit 2
  }
fi

cleanup() {
  if [[ -n "$pid_file" && -f "$pid_file" ]] && [[ "$(cat "$pid_file" 2>/dev/null || true)" == "$$" ]]; then
    rm -f "$pid_file"
  fi
}
trap cleanup EXIT INT TERM

if [[ -n "$pid_file" ]]; then
  [[ "$pid_file" == /* ]] || { echo "--pid-file must be an absolute path" >&2; exit 2; }
  mkdir -p "$(dirname "$pid_file")"
  printf '%s\n' "$$" >"$pid_file"
fi

emit() {
  local line key
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    printf '[%s] %s: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$label" "$line"
    if [[ "$SHIP_NOTIFY" == "1" && -x "$SHIP_NOTIFY_BIN" ]]; then
      key=$(printf '%s' "$events_file|$line" | cksum | awk '{print $1}')
      "$SHIP_NOTIFY_BIN" "$label: $line" "material-$key" || true
    fi
  done
}

if [[ "$once" -eq 1 ]]; then
  [[ -f "$events_file" ]] || { echo "events file not found: $events_file" >&2; exit 1; }
  "$MATERIAL_FILTER" <"$events_file" | emit
  exit 0
fi

# The exact path can be reported before the writer creates the file. Wait for
# that path only; do not fall back to a latest-run search.
while [[ ! -f "$events_file" ]]; do
  sleep 1
done

tail -n 0 -F "$events_file" | "$MATERIAL_FILTER" --until-ship-terminal | emit
