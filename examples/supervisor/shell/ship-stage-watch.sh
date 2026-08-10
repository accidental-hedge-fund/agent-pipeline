#!/usr/bin/env bash
# Watch agent-pipeline loop + advance events; notify on stage transitions.
#
#   ship-stage-watch.sh --milestone v1.33.0
#   ship-stage-watch.sh --issue 870 [--label "single #870"]
#   ship-stage-watch.sh --milestone v1.33.0 --once
#
# Environment:
#   SHIP_NOTIFY_BIN           path to ship-notify.sh (default: sibling script)
#   PIPELINE_SUPERVISOR_STATE state root
#   AGENT_PIPELINE_LOOP_ROOT  loop runs dir (default: ~/.local/state/agent-pipeline/loop/runs)
#   AGENT_PIPELINE_RUNS_ROOT  advance run dirs (default: $REPO_DIR/.agent-pipeline/runs)
#   REPO_DIR                  used to derive RUNS_ROOT when unset
#   SHIP_STAGE_WATCH_POLL_S   poll interval (default 5)
#
# Filters: drops #None / #null issue noise; skips stale precondition exclusions
# once an issue later starts or advances.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
SHIP_NOTIFY_BIN="${SHIP_NOTIFY_BIN:-$SCRIPT_DIR/ship-notify.sh}"
STATE_ROOT="${PIPELINE_SUPERVISOR_STATE:-$HOME/.local/state/pipeline-supervisor}"
LOOP_ROOT="${AGENT_PIPELINE_LOOP_ROOT:-$HOME/.local/state/agent-pipeline/loop/runs}"
REPO_DIR="${REPO_DIR:-}"
if [[ -n "${AGENT_PIPELINE_RUNS_ROOT:-}" ]]; then
  RUNS_ROOT="$AGENT_PIPELINE_RUNS_ROOT"
elif [[ -n "$REPO_DIR" ]]; then
  RUNS_ROOT="$REPO_DIR/.agent-pipeline/runs"
else
  RUNS_ROOT=""
fi
POLL_S="${SHIP_STAGE_WATCH_POLL_S:-5}"
ONCE=0
MILESTONE=""
ISSUE=""
LABEL=""
PID_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --milestone|-m) MILESTONE=${2:-}; shift 2 ;;
    --issue|-i) ISSUE=${2:-}; shift 2 ;;
    --label|-l) LABEL=${2:-}; shift 2 ;;
    --once) ONCE=1; shift ;;
    --pid-file) PID_FILE=${2:-}; shift 2 ;;
    -h|--help)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$MILESTONE" && -z "$ISSUE" ]]; then
  echo "need --milestone and/or --issue" >&2
  exit 2
fi
if [[ -z "$LABEL" ]]; then
  if [[ -n "$MILESTONE" ]]; then LABEL="ship $MILESTONE"; else LABEL="single #$ISSUE"; fi
fi
if [[ -n "$MILESTONE" ]]; then
  safe=$(echo "$MILESTONE" | tr '/' '-')
  SEEN_DIR="$STATE_ROOT/ship-$safe/stage-watch"
else
  safe=$(echo "issue-$ISSUE" | tr '/' '-')
  SEEN_DIR="$STATE_ROOT/stage-watch/$safe"
fi
mkdir -p "$SEEN_DIR"
SEEN_FILE="$SEEN_DIR/seen-keys.txt"
touch "$SEEN_FILE"
[[ -n "$PID_FILE" ]] && echo $$ >"$PID_FILE"

notify() {
  [[ -x "$SHIP_NOTIFY_BIN" ]] || return 0
  "$SHIP_NOTIFY_BIN" "$1" "$2" --force || true
}
already() { grep -Fxq "$1" "$SEEN_FILE" 2>/dev/null; }
mark() { echo "$1" >>"$SEEN_FILE"; }

scan() {
  local loop
  loop=$(ls -td "$LOOP_ROOT"/loop-* 2>/dev/null | head -1 || true)
  [[ -n "$loop" && -f "$loop/events.jsonl" ]] || return 0
  python3 - "$loop/events.jsonl" "$SEEN_FILE" "$LABEL" "${ISSUE:-}" "${RUNS_ROOT:-}" <<'PY'
import json, sys, os, re

ev_path, seen_path, label, issue_filter, runs_root = sys.argv[1:6]
issue_filter = str(issue_filter).strip() if issue_filter else ""
seen = {l.strip() for l in open(seen_path) if l.strip()} if os.path.exists(seen_path) else set()

def fmt_issue(issue):
    if issue is None or str(issue) in ("None", "null", ""):
        return None
    return str(issue)

def want(issue):
    issue = fmt_issue(issue)
    if not issue:
        return False
    if not issue_filter:
        return True
    return issue == issue_filter

def issue_from_run_id(rid):
    if not rid:
        return None
    m = re.match(r"^(\d+)-", str(rid))
    return m.group(1) if m else None

def issue_from_path(path):
    base = os.path.basename(os.path.dirname(path))
    m = re.match(r"^(\d+)", base)
    return m.group(1) if m else None

events = []
with open(ev_path) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except Exception:
            continue

later_ok = set()
for ev in events:
    k = ev.get("kind")
    d = ev.get("data") or {}
    if k in ("loop_item_started", "loop_item_stage_progress", "loop_item_advance_linked"):
        issue = fmt_issue(d.get("item_id"))
        if issue:
            later_ok.add(issue)

new = []
last_loop_issue = issue_filter or None
loop_stage_keys = set()

for ev in events:
    k = ev.get("kind")
    d = ev.get("data") or {}
    t = ev.get("time") or ""
    if k == "loop_item_stage_progress":
        issue = fmt_issue(d.get("item_id"))
        stage, at = d.get("stage"), d.get("at") or t
        if not issue or not want(issue):
            continue
        last_loop_issue = issue
        key = f"loop-stage-{issue}-{stage}-{at}"
        if key not in seen:
            new.append((key, f"{label}: #{issue} → {stage}"))
        loop_stage_keys.add((issue, str(stage)))
    elif k == "loop_item_started":
        issue = fmt_issue(d.get("item_id"))
        if not issue or not want(issue):
            continue
        last_loop_issue = issue
        key = f"loop-start-{issue}-{t}"
        if key not in seen:
            new.append((key, f"{label}: #{issue} advance started"))
    elif k == "loop_item_precondition_excluded":
        issue = fmt_issue(d.get("item_id"))
        req, obs = d.get("required_stage"), d.get("observed_stage")
        if not issue or not want(issue):
            continue
        if issue in later_ok:
            continue
        key = f"loop-excl-{issue}-{obs}-{req}-{t}"
        if key not in seen:
            new.append((key, f"{label}: #{issue} not dispatchable (need {req}, have {obs})"))

adv_by_item = {}
for ev in events:
    if ev.get("kind") != "loop_item_advance_linked":
        continue
    d = ev.get("data") or {}
    item = fmt_issue(d.get("item_id"))
    path = d.get("events")
    if path and (not issue_filter or item == issue_filter or item is None):
        adv_by_item[item or "_"] = path

if issue_filter and runs_root and os.path.isdir(runs_root):
    cands = [
        os.path.join(runs_root, d, "events.jsonl")
        for d in os.listdir(runs_root)
        if d.startswith(issue_filter + "-")
    ]
    cands = [c for c in cands if os.path.isfile(c)]
    if cands:
        cands.sort(key=os.path.getmtime, reverse=True)
        adv_by_item[issue_filter] = cands[0]

for item_key, adv in adv_by_item.items():
    if not adv or not os.path.isfile(adv):
        continue
    path_issue = (
        issue_from_path(adv)
        or (item_key if item_key != "_" else None)
        or last_loop_issue
        or issue_filter
    )
    with open(adv) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except Exception:
                continue
            typ = ev.get("type") or ev.get("kind")
            at = ev.get("at") or ""
            stage = ev.get("stage")
            issue = (
                fmt_issue(ev.get("issue"))
                or issue_from_run_id(ev.get("run_id"))
                or fmt_issue(path_issue)
            )
            if not issue or not want(issue):
                continue
            if typ == "stage_start" and stage:
                if (issue, str(stage)) in loop_stage_keys:
                    continue
                key = f"adv-start-{issue}-{stage}-{at}"
                if key not in seen:
                    new.append((key, f"{label}: #{issue} stage start → {stage}"))
            elif typ == "stage_complete" and stage:
                if (issue, str(stage)) in loop_stage_keys:
                    continue
                outcome = ev.get("outcome") or "done"
                key = f"adv-done-{issue}-{stage}-{at}-{outcome}"
                if key not in seen:
                    new.append((key, f"{label}: #{issue} stage done → {stage} ({outcome})"))
            elif typ == "pr_created":
                pr = ev.get("pr")
                key = f"adv-pr-{issue}-{pr}"
                if key not in seen:
                    new.append((key, f"{label}: #{issue} PR opened #{pr}"))

for key, msg in new:
    if "#None" in msg or "#null" in msg:
        continue
    print(f"{key}\t{msg}")
PY
}

emit() {
  local line key msg
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    key=${line%%$'\t'*}
    msg=${line#*$'\t'}
    case "$msg" in *'#None'*|*'#null'*) continue ;; esac
    already "$key" && continue
    mark "$key"
    notify "$msg" "stage-$key"
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $msg"
  done
}

pipeline_still_running() {
  local line
  while IFS= read -r line; do
    case "$line" in *ship-stage-watch*) continue ;; esac
    if [[ -n "$ISSUE" ]]; then
      if echo "$line" | grep -E "pipeline(\.mjs)?.*(single[[:space:]]+${ISSUE}|[[:space:]]${ISSUE})([[:space:]]|$)" >/dev/null; then
        return 0
      fi
    fi
    if [[ -n "$MILESTONE" ]]; then
      case "$line" in
        *"train --milestone ${MILESTONE}"*|*"ship-milestone.sh --milestone ${MILESTONE}"*|*"pipeline-ship-playbook --milestone ${MILESTONE}"*)
          return 0
          ;;
      esac
    fi
  done < <(ps -eo args= 2>/dev/null || true)
  return 1
}

if [[ "$ONCE" -eq 1 ]]; then
  scan | emit
  exit 0
fi
for _ in $(seq 1 12); do
  pipeline_still_running && break
  sleep 1
done
while true; do
  scan | emit
  if ! pipeline_still_running; then
    sleep 3
    scan | emit
    if ! pipeline_still_running; then
      notify "${LABEL}: stage-watch stopping (pipeline process ended)" "stage-watch-stop-$$"
      exit 0
    fi
  fi
  sleep "${POLL_S}"
done
