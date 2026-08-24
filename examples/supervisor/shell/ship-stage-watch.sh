#!/usr/bin/env bash
# Observe one exact Pipeline run event stream through the shared material
# filter. The caller must supply the absolute events.jsonl path returned by
# Pipeline; this adapter never searches host-global run directories.
#
#   ship-stage-watch.sh --events-file /absolute/run/events.jsonl \
#     [--label "ship v1.34.0"] [--channel <id>] [--reply-to <event-id>] [--once]
#
# Follow mode exits on the bound stream's identity-terminal (loop_run_superseded,
# loop_run_complete, loop_run_stopped on a loop file; ship_phase complete on a
# ship file). It does not wait for ship_phase on a loop file, and it does not
# open a superseded_by path. Tugboat re-binds --events-file to a later handoff.
#
# Environment:
#   PIPELINE_MATERIAL_FILTER  installed material-filter.mjs executable
#   SHIP_NOTIFY_BIN           messenger adapter (default: sibling script)
#   SHIP_NOTIFY               0 disables messenger calls (default 1)
#   SHIP_STAGE_WATCH_IDLE_SECS  inactivity bound after identity-terminal
#                               (default 30). Does not kill a live quiet run.
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
the current cursor and exits on that file's identity-terminal event
(loop_run_superseded / loop_run_complete / loop_run_stopped for a loop file;
ship_phase complete for a ship file), or after SHIP_STAGE_WATCH_IDLE_SECS
(default 30) of inactivity once that terminal was seen. This command does
not discover latest loop or advance runs and does not follow superseded_by.
Set PIPELINE_MATERIAL_FILTER to the installed material-filter.mjs executable.
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

tail_pid=""
watchdog_pid=""
work_dir=""
terminal_seen=""
last_line_ts=""

cleanup() {
  local child
  [[ "${cleanup_done:-0}" -eq 1 ]] && return 0
  cleanup_done=1
  for child in ${watchdog_pid:-} ${tail_pid:-} $(pgrep -P $$ 2>/dev/null || true); do
    [[ -n "$child" && "$child" =~ ^[0-9]+$ ]] || continue
    kill "$child" 2>/dev/null || true
  done
  sleep 0.05
  for child in ${watchdog_pid:-} ${tail_pid:-} $(pgrep -P $$ 2>/dev/null || true); do
    [[ -n "$child" && "$child" =~ ^[0-9]+$ ]] || continue
    kill -KILL "$child" 2>/dev/null || true
  done
  if [[ -n "${work_dir:-}" && -d "$work_dir" ]]; then
    rm -rf "$work_dir"
  fi
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

note_follow_line() {
  local line=$1
  [[ -n "${terminal_seen:-}" ]] || return 0
  case "$line" in
    *'[loop_run_superseded]'*|*'[loop_run_complete]'*|*'[loop_run_stopped]'*|*'[ship_phase] complete → completed'*)
      date +%s >"$last_line_ts"
      : >"$terminal_seen"
      ;;
    *)
      if [[ -f "$terminal_seen" ]]; then
        date +%s >"$last_line_ts"
      fi
      ;;
  esac
}

emit() {
  local line key
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    printf '[%s] %s: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$label" "$line"
    if [[ "$SHIP_NOTIFY" == "1" && -x "$SHIP_NOTIFY_BIN" ]]; then
      key=$(printf '%s' "$events_file|$line" | cksum | awk '{print $1}')
      "$SHIP_NOTIFY_BIN" "$label: $line" "material-$key" || true
    fi
    note_follow_line "$line"
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

idle_secs="${SHIP_STAGE_WATCH_IDLE_SECS:-30}"
if ! [[ "$idle_secs" =~ ^[0-9]+$ ]]; then
  idle_secs=30
fi

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/ship-stage-watch.XXXXXX")
fifo="$work_dir/events.fifo"
terminal_seen="$work_dir/terminal.seen"
last_line_ts="$work_dir/last.ts"
mkfifo "$fifo"

# Own the follow child. `tail -F | filter | emit` under pipefail hangs after
# identity-terminal because a silent file never SIGPIPEs tail.
tail -n 0 -F "$events_file" >"$fifo" &
tail_pid=$!

(
  while true; do
    if [[ -f "$terminal_seen" ]]; then
      last=$(cat "$last_line_ts" 2>/dev/null || echo 0)
      now=$(date +%s)
      if [[ "$last" =~ ^[0-9]+$ ]] && [[ $((now - last)) -ge $idle_secs ]]; then
        kill "$tail_pid" 2>/dev/null || true
        exit 0
      fi
    fi
    sleep 0.2
  done
) &
watchdog_pid=$!

# Forward JSONL, classify identity-terminal of THIS bound file, then stop so
# pipefail cannot wait on silent tail -F. Do not open superseded_by or glob
# host-global run directories.
set +e
python3 - "$fifo" "$terminal_seen" "$last_line_ts" "$tail_pid" <<'PY' | "$MATERIAL_FILTER" --until-identity-terminal | emit
import json
import os
import signal
import sys
import time

signal.signal(signal.SIGPIPE, signal.SIG_IGN)

fifo, marker, ts_path, tail_pid_s = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
loop_kinds = {"loop_run_superseded", "loop_run_complete", "loop_run_stopped"}

def is_identity_terminal(obj):
    if not isinstance(obj, dict):
        return False
    kind = obj.get("kind")
    if kind in loop_kinds:
        return True
    return (
        kind == "ship_phase"
        and obj.get("phase") == "complete"
        and obj.get("status") == "completed"
    )

def mark_and_stop_follow():
    now = str(int(time.time()))
    with open(ts_path, "w", encoding="utf-8") as fh:
        fh.write(now)
    with open(marker, "w", encoding="utf-8") as fh:
        fh.write("1")
    try:
        os.kill(int(tail_pid_s), signal.SIGTERM)
    except OSError:
        pass

try:
    with open(fifo, encoding="utf-8", errors="replace") as src:
        for line in src:
            try:
                sys.stdout.write(line)
                sys.stdout.flush()
            except BrokenPipeError:
                sys.exit(0)
            s = line.strip()
            if not s.startswith("{"):
                continue
            try:
                obj = json.loads(s)
            except json.JSONDecodeError:
                continue
            if is_identity_terminal(obj):
                mark_and_stop_follow()
                sys.exit(0)
except BrokenPipeError:
    sys.exit(0)
PY
kill "$tail_pid" 2>/dev/null || true
kill "$watchdog_pid" 2>/dev/null || true
exit 0
