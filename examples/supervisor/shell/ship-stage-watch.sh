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
# ship file), including when that event already exists before follow starts.
# It does not wait for ship_phase on a loop file, and it does not open a
# superseded_by path. Tugboat re-binds --events-file to a later handoff.
#
# Environment:
#   PIPELINE_MATERIAL_FILTER  installed material-filter.mjs executable
#   SHIP_NOTIFY_BIN           messenger adapter (default: sibling script)
#   SHIP_NOTIFY               0 disables messenger calls (default 1)
#   SHIP_STAGE_WATCH_IDLE_SECS  inactivity bound after identity-terminal
#                               (default 30). Does not kill a live quiet run.
#   SHIP_STAGE_WATCH_SCAN_EOF_HOLD  test-only dir; after scan EOF write
#                                   eof-reached and wait for continue.
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
(default 30) of inactivity once that terminal was seen. If the bound file
already contains identity-terminal before follow starts, the observer emits
that material line and exits instead of waiting on a silent follow. A
terminal appended after the initial scan reaches EOF is consumed from the
same tracked offset. This command does not discover latest loop or advance
runs and does not follow superseded_by.
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

watchdog_pid=""
work_dir=""
terminal_seen=""
last_line_ts=""

cleanup() {
  local child
  [[ "${cleanup_done:-0}" -eq 1 ]] && return 0
  cleanup_done=1
  for child in ${watchdog_pid:-} $(pgrep -P $$ 2>/dev/null || true); do
    [[ -n "$child" && "$child" =~ ^[0-9]+$ ]] || continue
    kill "$child" 2>/dev/null || true
  done
  sleep 0.05
  for child in ${watchdog_pid:-} $(pgrep -P $$ 2>/dev/null || true); do
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
terminal_seen="$work_dir/terminal.seen"
last_line_ts="$work_dir/last.ts"

# Own the follow child. `tail -F | filter | emit` under pipefail hangs after
# identity-terminal because a silent file never SIGPIPEs tail. One offset-
# tracked reader scans this exact bound file and continues from the same
# cursor so an append during startup is not lost. Do not open a FIFO plus
# `tail -n 0 -F`: that attach waits until the reader opens, so a terminal
# written after scan EOF and before attach is missed.
(
  while true; do
    if [[ -f "$terminal_seen" ]]; then
      last=$(cat "$last_line_ts" 2>/dev/null || echo 0)
      now=$(date +%s)
      if [[ "$last" =~ ^[0-9]+$ ]] && [[ $((now - last)) -ge $idle_secs ]]; then
        for child in $(pgrep -P $$ 2>/dev/null || true); do
          [[ -n "$child" && "$child" =~ ^[0-9]+$ ]] || continue
          [[ "$child" -eq "${BASHPID:-0}" ]] && continue
          kill "$child" 2>/dev/null || true
        done
        exit 0
      fi
    fi
    sleep 0.2
  done
) &
watchdog_pid=$!

# Forward JSONL, classify identity-terminal of THIS bound file, then stop so
# pipefail cannot wait on a silent follow. Do not open superseded_by or glob
# host-global run directories.
set +e
python3 - "$terminal_seen" "$last_line_ts" "$events_file" <<'PY' | "$MATERIAL_FILTER" --until-identity-terminal | emit
import json
import os
import signal
import sys
import time

signal.signal(signal.SIGPIPE, signal.SIG_IGN)

marker, ts_path, events_path = sys.argv[1], sys.argv[2], sys.argv[3]
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

def emit_line(line):
    out = line if line.endswith("\n") else line + "\n"
    try:
        sys.stdout.write(out)
        sys.stdout.flush()
    except BrokenPipeError:
        sys.exit(0)

def classify_line(line, emit_all):
    if emit_all:
        emit_line(line)
    s = line.strip()
    if not s.startswith("{"):
        return False
    try:
        obj = json.loads(s)
    except json.JSONDecodeError:
        return False
    if not is_identity_terminal(obj):
        return False
    if not emit_all:
        emit_line(line)
    mark_and_stop_follow()
    return True

def consume(src, emit_all):
    while True:
        pos = src.tell()
        line = src.readline()
        if line == "" or not line.endswith("\n"):
            return pos, False
        if classify_line(line, emit_all):
            return src.tell(), True

offset = 0
try:
    with open(events_path, encoding="utf-8", errors="replace") as existing:
        offset, terminal = consume(existing, False)
        if terminal:
            sys.exit(0)
except OSError:
    pass

# Test-only: pause after scan EOF so a fixture can append at this cursor.
hold_dir = os.environ.get("SHIP_STAGE_WATCH_SCAN_EOF_HOLD", "")
if hold_dir and os.path.isdir(hold_dir):
    with open(os.path.join(hold_dir, "eof-reached"), "w", encoding="utf-8") as fh:
        fh.write("1")
    cont = os.path.join(hold_dir, "continue")
    while not os.path.exists(cont):
        time.sleep(0.05)

try:
    while True:
        try:
            with open(events_path, encoding="utf-8", errors="replace") as src:
                src.seek(offset)
                offset, terminal = consume(src, True)
                if terminal:
                    sys.exit(0)
        except OSError:
            pass
        time.sleep(0.1)
except BrokenPipeError:
    sys.exit(0)
PY
kill "$watchdog_pid" 2>/dev/null || true
exit 0
