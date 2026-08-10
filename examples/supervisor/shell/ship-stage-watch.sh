#!/usr/bin/env bash
# Watch agent-pipeline loop + advance events; notify on stage transitions.
#
#   ship-stage-watch.sh --milestone v1.33.0
#   ship-stage-watch.sh --issue 870 [--label "single #870"]
#   ship-stage-watch.sh --milestone v1.33.0 --once
#   ship-stage-watch.sh --milestone v1.34.0 --since 2026-08-10T13:24:00Z
#
# Environment:
#   SHIP_NOTIFY_BIN           path to ship-notify.sh (default: sibling script)
#   PIPELINE_SUPERVISOR_STATE state root
#   AGENT_PIPELINE_LOOP_ROOT  loop runs dir (default: ~/.local/state/agent-pipeline/loop/runs)
#   AGENT_PIPELINE_RUNS_ROOT  advance run dirs (default: $REPO_DIR/.agent-pipeline/runs)
#   REPO_DIR                  used to derive RUNS_ROOT when unset
#   SHIP_STAGE_WATCH_POLL_S   poll interval (default 5)
#
# Scope (critical — avoids rebroadcasting unrelated history under a ship label):
#   1. Events older than --since (default: this process start, UTC) are ignored.
#   2. With --issue N, only that issue is eligible.
#   3. With --milestone and no --issue, when train.json (or --issues-file) lists
#      ordered_issues, only those issues are eligible. Until that list exists,
#      only the since-watermark applies (still no pre-ship history).
#   4. Drops #None / #null; skips stale precondition exclusions once an issue
#      later starts or advances (within the scoped event set).
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
SINCE=""
ISSUES_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --milestone|-m) MILESTONE=${2:-}; shift 2 ;;
    --issue|-i) ISSUE=${2:-}; shift 2 ;;
    --label|-l) LABEL=${2:-}; shift 2 ;;
    --since) SINCE=${2:-}; shift 2 ;;
    --issues-file) ISSUES_FILE=${2:-}; shift 2 ;;
    --once) ONCE=1; shift ;;
    --pid-file) PID_FILE=${2:-}; shift 2 ;;
    -h|--help)
      sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
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
  if [[ -z "$ISSUES_FILE" ]]; then
    ISSUES_FILE="$STATE_ROOT/ship-$safe/train.json"
  fi
else
  safe=$(echo "issue-$ISSUE" | tr '/' '-')
  SEEN_DIR="$STATE_ROOT/stage-watch/$safe"
fi
mkdir -p "$SEEN_DIR"
SEEN_FILE="$SEEN_DIR/seen-keys.txt"
touch "$SEEN_FILE"
[[ -n "$PID_FILE" ]] && echo $$ >"$PID_FILE"

# Session watermark: never notify events strictly before this process started
# (unless operator passed --since). Written for debugging; not reused across
# processes so a re-ship for the same milestone does not inherit a stale clock.
if [[ -z "$SINCE" ]]; then
  SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
fi
printf '%s\n' "$SINCE" >"$SEEN_DIR/session-since.txt"

notify() {
  [[ -x "$SHIP_NOTIFY_BIN" ]] || return 0
  "$SHIP_NOTIFY_BIN" "$1" "$2" --force || true
}
already() { grep -Fxq "$1" "$SEEN_FILE" 2>/dev/null; }
mark() { echo "$1" >>"$SEEN_FILE"; }

# Scan every loop run that may hold in-scope events (not only "latest").
# A ship that starts while an older loop is still the newest dir would otherwise
# stamp that whole history with the new ship label when seen-keys is empty.
scan() {
  local loops=()
  local d
  if [[ -d "$LOOP_ROOT" ]]; then
    while IFS= read -r d; do
      [[ -n "$d" && -f "$d/events.jsonl" ]] && loops+=("$d")
    done < <(ls -td "$LOOP_ROOT"/loop-* 2>/dev/null || true)
  fi
  if [[ ${#loops[@]} -eq 0 ]]; then
    return 0
  fi
  # Cap: newest 20 loop dirs (ships are short; avoids scanning ancient archives)
  local limited=("${loops[@]:0:20}")
  python3 - "$SEEN_FILE" "$LABEL" "${ISSUE:-}" "${RUNS_ROOT:-}" "$SINCE" "${ISSUES_FILE:-}" "${limited[@]}" <<'PY'
import json, sys, os, re
from datetime import datetime, timezone

seen_path = sys.argv[1]
label = sys.argv[2]
issue_filter = str(sys.argv[3]).strip() if sys.argv[3] else ""
runs_root = sys.argv[4] or ""
since_raw = (sys.argv[5] or "").strip()
issues_file = (sys.argv[6] or "").strip()
loop_dirs = sys.argv[7:]

def parse_ts(s):
    if not s or not isinstance(s, str):
        return None
    s = s.strip()
    if not s:
        return None
    # Accept ...Z and ...+00:00; drop sub-second noise for compare
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        # truncate fractional seconds if present beyond fromisoformat comfort
        if "." in s and "+" in s[s.find("T"):]:
            head, rest = s.split(".", 1)
            # rest like 089Z already normalized, or 089+00:00
            frac_and_tz = rest
            m = re.match(r"^(\d+)(.*)$", frac_and_tz)
            if m:
                s = head + m.group(2)
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None

since = parse_ts(since_raw)
if since is None and since_raw:
    # Fail closed: refuse to emit anything if --since is unparsable
    sys.stderr.write(f"ship-stage-watch: invalid --since {since_raw!r}\n")
    sys.exit(2)

seen = {l.strip() for l in open(seen_path) if l.strip()} if os.path.exists(seen_path) else set()

allow_issues = None  # None = no train allowlist yet; set() would mean empty list
if issues_file and os.path.isfile(issues_file):
    try:
        raw = open(issues_file).read().strip()
        if raw:
            dec = json.JSONDecoder()
            i = 0
            objs = []
            while i < len(raw):
                while i < len(raw) and raw[i].isspace():
                    i += 1
                if i >= len(raw):
                    break
                try:
                    o, j = dec.raw_decode(raw, i)
                    objs.append(o)
                    i = j
                except Exception:
                    n = raw.find("{", i + 1)
                    if n < 0:
                        break
                    i = n
            for o in reversed(objs):
                if not isinstance(o, dict):
                    continue
                if o.get("kind") == "train_status" and "ordered_issues" in o:
                    allow_issues = {
                        str(x) for x in (o.get("ordered_issues") or []) if x is not None
                    }
                    break
                if o.get("kind") == "loop_run_handoff":
                    sel = o.get("selector") or {}
                    if sel.get("type") == "work-list" and sel.get("value"):
                        allow_issues = {str(x) for x in sel["value"] if x is not None}
                        break
    except Exception:
        allow_issues = None

def fmt_issue(issue):
    if issue is None or str(issue) in ("None", "null", ""):
        return None
    return str(issue)

def want(issue):
    issue = fmt_issue(issue)
    if not issue:
        return False
    if issue_filter and issue != issue_filter:
        return False
    if allow_issues is not None and issue not in allow_issues:
        return False
    return True

def fresh(ts_str):
    """True if event is at/after since (or no since / unparsable → drop when since set)."""
    if since is None:
        return True
    ts = parse_ts(ts_str)
    if ts is None:
        # Fail closed for historical rebroadcast: no timestamp = not notify
        return False
    return ts >= since

def issue_from_run_id(rid):
    if not rid:
        return None
    m = re.match(r"^(\d+)-", str(rid))
    return m.group(1) if m else None

def issue_from_path(path):
    base = os.path.basename(os.path.dirname(path))
    m = re.match(r"^(\d+)", base)
    return m.group(1) if m else None

def load_events(path):
    out = []
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except Exception:
                    continue
    except OSError:
        pass
    return out

events = []
for ld in loop_dirs:
    ep = os.path.join(ld, "events.jsonl")
    events.extend(load_events(ep))

later_ok = set()
for ev in events:
    k = ev.get("kind")
    d = ev.get("data") or {}
    t = ev.get("time") or ""
    if not fresh(t):
        continue
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
    if not fresh(t):
        continue
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
    t = ev.get("time") or ""
    if not fresh(t):
        continue
    if ev.get("kind") != "loop_item_advance_linked":
        continue
    d = ev.get("data") or {}
    item = fmt_issue(d.get("item_id"))
    path = d.get("events")
    if not path:
        continue
    # Null item only allowed when no issue scope is active
    if item is None:
        if issue_filter or allow_issues is not None:
            continue
    elif not want(item):
        continue
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
elif allow_issues and runs_root and os.path.isdir(runs_root):
    for iss in allow_issues:
        cands = [
            os.path.join(runs_root, d, "events.jsonl")
            for d in os.listdir(runs_root)
            if d.startswith(iss + "-")
        ]
        cands = [c for c in cands if os.path.isfile(c)]
        if cands:
            cands.sort(key=os.path.getmtime, reverse=True)
            adv_by_item[iss] = cands[0]

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
            if not fresh(at):
                continue
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
