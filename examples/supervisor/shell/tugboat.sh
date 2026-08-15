#!/usr/bin/env bash
# Tugboat — thin ship composer (Option 1, #1001).
#
# Ship = compose existing Pipeline CLI verbs + wait + notify. Nothing more.
#   train --milestone --merge  →  release  →  wait CI green  →  release finish
#   →  wait GitHub Release  →  engine-promote --host all
#
# `--merge` train is **serial** (#1063): merge-first R2D, one implement, STOP on
# blocked/needs-human. Never `pipeline single` / `pipeline loop` for a milestone
# ship — that is the PR farm. Loop frontiers stay on `pipeline loop` only.
#
# No second merge policy, no grant factory, no `pipeline ship` subcommand.
#
# Usage:
#   tugboat.sh --milestone v1.37.0 [--detach]
#   tugboat.sh --milestones v1.37.0 v1.38.0 [--detach]   # serial; promote between
#   tugboat.sh --milestone v1.37.0 --status
#
# Environment:
#   REPO_DIR               worktree (required for ship/detach) — resolved once
#                          at start from install/env. Paths matching
#                          *factory-control* are refused (#1062). Session/model
#                          text cannot retarget after pin.
#   PIPELINE               pipeline launcher (default: pipeline)
#   ALLOW_MERGE            must be 1 for train --merge / release finish
#   SHIP_NOTIFY            1 to post phase status (default 1)
#   SHIP_NOTIFY_BIN        notify helper (default: sibling ship-notify.sh)
#   SHIP_STAGE_WATCH_BIN   optional per-issue stage posts during train
#   RELEASE_WAIT_ATTEMPTS  CI/release wait poll attempts (default 30)
#   RELEASE_WAIT_SLEEP_S   wait sleep seconds (default 40)
#   ENGINE_PROMOTE_HOST    promote host scope (default all)
#   PIPELINE_SUPERVISOR_STATE  state root
#
# Live ship (#1062): a milestone is "already running" only when a live process
# cmdline is train --merge for that milestone, or the owning tugboat for it.
# Bare playbook.pid + kill -0, per-issue pipeline N locks, and stale state.json
# alone are NOT live ships and must not refuse detach.
#
# Version rules (hard-won):
#   train --milestone wants "vX.Y.Z"
#   release <version> wants bare "X.Y.Z" (leading v is INVALID)
#   engine-promote --for accepts bare or v (strips v)
#   gh release view wants "vX.Y.Z"
#
# State: $PIPELINE_SUPERVISOR_STATE/ship-vX.Y.Z/{state.json,playbook.log,...}
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
STATE_ROOT="${PIPELINE_SUPERVISOR_STATE:-$HOME/.local/state/pipeline-supervisor}"
# Pin snapshot of env at process start — never re-read for retarget (#1062).
REPO_DIR="${REPO_DIR:-}"
PIPELINE="${PIPELINE:-pipeline}"
ALLOW_MERGE="${ALLOW_MERGE:-0}"
SHIP_NOTIFY="${SHIP_NOTIFY:-1}"
SHIP_NOTIFY_BIN="${SHIP_NOTIFY_BIN:-$SCRIPT_DIR/ship-notify.sh}"
SHIP_STAGE_WATCH_BIN="${SHIP_STAGE_WATCH_BIN:-$SCRIPT_DIR/ship-stage-watch.sh}"
RELEASE_WAIT_ATTEMPTS="${RELEASE_WAIT_ATTEMPTS:-30}"
RELEASE_WAIT_SLEEP_S="${RELEASE_WAIT_SLEEP_S:-40}"
ENGINE_PROMOTE_HOST="${ENGINE_PROMOTE_HOST:-all}"
RELEASE_CHECKS_GREEN_BIN="${RELEASE_CHECKS_GREEN_BIN:-$SCRIPT_DIR/release-checks-green.py}"
TRAIN_STATUS_COMPLETE_BIN="${TRAIN_STATUS_COMPLETE_BIN:-$SCRIPT_DIR/train-status-complete.py}"
REPO_DIR_PINNED=0

milestones=()
do_detach=0
do_status=0

usage() {
  cat <<'USAGE'
Usage:
  tugboat.sh --milestone vX.Y.Z [--detach]
  tugboat.sh --milestones vA.B.C vD.E.F [--detach]   # serial; promote after each
  tugboat.sh --milestone vX.Y.Z --status
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --milestone|-m)
      [[ -n "${2:-}" ]] || { echo "missing value for $1" >&2; exit 2; }
      milestones+=("${2#v}")
      shift 2
      ;;
    --milestones)
      shift
      while [[ $# -gt 0 && "$1" != --* ]]; do
        milestones+=("${1#v}")
        shift
      done
      ;;
    --detach)
      do_detach=1
      shift
      ;;
    --status)
      do_status=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      usage
      exit 2
      ;;
  esac
done

[[ ${#milestones[@]} -ge 1 ]] || { usage; exit 2; }

# ---------- helpers ---------------------------------------------------------

json_str() {
  python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"
}

# Keep dots (ship-v1.36.0), lowercase only — matches historical state dirs.
safe_of() {
  echo "$1" | tr 'A-Z' 'a-z'
}

log() {
  local line="[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"
  echo "$line" | tee -a "$LOG_FILE"
}

notify() {
  [[ "$SHIP_NOTIFY" == "1" ]] || return 0
  [[ -x "$SHIP_NOTIFY_BIN" ]] || return 0
  "$SHIP_NOTIFY_BIN" "$@" || true
}

write_state() {
  local phase=$1 status=$2
  local detail=${3:-}
  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  mkdir -p "$RUN_DIR"
  # On failure, enrich the posted detail with the actual reason from the
  # phase's captured output so operators never have to ask "what failed?".
  if [[ "$status" == "failed" && -n "$phase" ]]; then
    local reason
    reason=$(failure_detail "$phase")
    if [[ -n "$reason" ]]; then
      detail="${detail:+$detail; }$reason"
    fi
  fi
  cat >"$STATE_FILE" <<JSON
{
  "schema_version": 1,
  "kind": "tugboat_ship",
  "milestone": $(json_str "v$version"),
  "version": $(json_str "$version"),
  "phase": $(json_str "$phase"),
  "status": $(json_str "$status"),
  "detail": $(json_str "$detail"),
  "updated_at": "$now",
  "log": $(json_str "$LOG_FILE"),
  "pid": ${PID:-$$}
}
JSON
  local msg="ship v$version: ${phase} → ${status}"
  [[ -n "$detail" ]] && msg="${msg} (${detail})"
  notify "$msg" "tug-$(safe_of "$version")-${phase}-${status}-$$-$(date +%s)" --force
}

# Prefer operator-useful stderr (loop lock, refuse takeover) over a bare
# "exited with code 1" blocker sidecar.
train_stderr_reason() {
  local f="$RUN_DIR/train.stderr"
  [[ -s "$f" ]] || return 0
  local reason
  reason=$(grep -iE 'lock is held|refusing takeover|not verifiably dead|another tugboat|already running' "$f" 2>/dev/null | tail -1)
  [[ -z "$reason" ]] && reason=$(grep -iE 'error|fail|block|refus|denied|deadlock|STOP:' "$f" 2>/dev/null | grep -viE '^\s*-' | tail -1)
  [[ -n "$reason" ]] && echo "$reason" | sed 's/^\[pipeline[^]]*\] *//' | head -c 400
}

failure_detail() {
  local phase=$1
  local f reason blocker
  case "$phase" in
    train)
      # Loop-lock / refuse lines beat a generic exit-code blocker.
      reason=$(train_stderr_reason)
      if [[ -n "$reason" ]]; then
        echo "$reason"
        return
      fi
      if [[ -s "$RUN_DIR/train.json.blocker" ]]; then
        blocker=$(cat "$RUN_DIR/train.json.blocker" 2>/dev/null | head -c 300)
        # If blocker is only "exited with code N", still try stderr/log.
        if [[ "$blocker" =~ exited\ with\ code\ [0-9]+$ ]] || [[ "$blocker" =~ train\ exit\ [0-9]+$ ]]; then
          reason=$(grep -iE 'lock is held|refusing|error|fail|block|STOP:' "$RUN_DIR/train.stderr" 2>/dev/null | tail -1)
          [[ -n "$reason" ]] && { echo "$reason" | head -c 400; return; }
        fi
        echo "$blocker"
        return
      fi
      f="$RUN_DIR/train.stderr"
      ;;
    release-prepare) f="$RUN_DIR/release-prepare.err" ;;
    release-finish) f="$RUN_DIR/release-finish.err" ;;
    wait-release) f="$RUN_DIR/gh-release.err" ;;
    engine-promote) f="$RUN_DIR/engine-promote.err" ;;
    *) f="$RUN_DIR/$phase.err" ;;
  esac
  if [[ -s "$f" ]]; then
    reason=$(grep -iE 'error|fail|block|refus|denied|pending|not green|invalid|missing|cannot|could not|exit [1-9]|deadlock|lock is held|takeover' "$f" 2>/dev/null | grep -viE '^\s*-' | tail -1)
    [[ -z "$reason" ]] && reason=$(grep -iE 'error|fail|block|refus|denied|pending|not green|invalid|missing|cannot|could not|exit [1-9]|deadlock|lock is held|takeover' "$f" 2>/dev/null | tail -1)
    [[ -z "$reason" ]] && reason=$(tail -1 "$f" 2>/dev/null)
    echo "$reason" | sed 's/^\[pipeline[^]]*\] *//' | head -c 400
    return
  fi
  if [[ -s "$LOG_FILE" ]]; then
    reason=$(grep -iE 'lock is held|refusing takeover|another tugboat|\[pipeline[^]]*\] .*(error|fail|block|refus|denied|not green|exit [1-9]|deadlock)' "$LOG_FILE" 2>/dev/null | tail -1)
    [[ -n "$reason" ]] && echo "$reason" | sed 's/^\[[0-9TZ:-]*\] *//' | head -c 400
  fi
}

# Resolve REPO_DIR once from install/env; refuse *factory-control* (#1062).
# After pin, this process never retargets from session/model text.
pin_repo_dir() {
  if [[ "$REPO_DIR_PINNED" == "1" ]]; then
    return 0
  fi
  if [[ -z "$REPO_DIR" ]]; then
    REPO_DIR_PINNED=1
    return 0
  fi
  if [[ ! -d "$REPO_DIR" ]]; then
    echo "FAIL: REPO_DIR required and must be a directory (got: $REPO_DIR)" >&2
    exit 1
  fi
  REPO_DIR=$(cd "$REPO_DIR" && pwd -P)
  case "$REPO_DIR" in
    *factory-control*)
      echo "FAIL: REPO_DIR refused — path matches *factory-control* (live ship plane is the control checkout, not factory-control): $REPO_DIR" >&2
      exit 1
      ;;
  esac
  REPO_DIR_PINNED=1
  export REPO_DIR
}

# Pure: space-separated cmdline is a live ship for bare version X.Y.Z (#1062).
# Live = train with --merge for this milestone, OR tugboat owning that ship
# (foreground/detached composer — not --status / not the --detach launcher).
# Does NOT treat bare playbook.pid, issue-run locks, or unrelated pids as live.
cmdline_is_live_ship() {
  local cmdline=$1
  local version=$2
  local tag="v${version}"
  # Normalize runs of whitespace for robust substring checks.
  cmdline=$(printf '%s' "$cmdline" | tr -s '[:space:]' ' ')
  [[ -n "$cmdline" ]] || return 1

  # Owning tugboat for this milestone (composer child). Exclude status/detach
  # wrappers so a --status read never looks like a live ship.
  case "$cmdline" in
    *tugboat*)
      case "$cmdline" in
        *--status*|*--detach*) ;;
        *)
          case "$cmdline" in
            *"--milestone ${tag}"*|*"--milestone ${version}"*) return 0 ;;
          esac
          if [[ "$cmdline" == *"--milestones"* ]]; then
            case " $cmdline " in
              *" ${tag} "*|*" ${version} "*) return 0 ;;
            esac
          fi
          ;;
      esac
      ;;
  esac

  # Detached train ship: must include train, --merge, and the milestone.
  # Per-issue "pipeline N" / "pipeline single N" never match (no --merge train).
  case "$cmdline" in
    *train*)
      case "$cmdline" in
        *--merge*)
          case "$cmdline" in
            *"--milestone ${tag}"*|*"--milestone ${version}"*) return 0 ;;
          esac
          case " $cmdline " in
            *" ${tag} "*) return 0 ;;
          esac
          ;;
      esac
      ;;
  esac
  return 1
}

# Live-ship probe: scan host process cmdlines. Fails open to "not live" when
# /proc is unreadable (never false-refuse detach on bare pid files).
# Prints matching pid on stdout when live; return 0 live / 1 not live.
# version = bare X.Y.Z (no leading v).
live_ship_probe() {
  local version=$1
  local pid cmdline
  local self=$$
  shopt -s nullglob
  for dir in /proc/[0-9]*; do
    pid=${dir#/proc/}
    [[ "$pid" == "$self" ]] && continue
    [[ -r "$dir/cmdline" ]] || continue
    # Convert null-separated argv to spaces.
    cmdline=$(tr '\0' ' ' <"$dir/cmdline" 2>/dev/null || true)
    [[ -n "${cmdline// /}" ]] || continue
    if cmdline_is_live_ship "$cmdline" "$version"; then
      printf '%s\n' "$pid"
      return 0
    fi
  done
  return 1
}

# Single-host milestone lock. Lock dir is the mutex; lock/pid is the holder.
# NEVER write playbook.pid before winning the lock (that race stole the mutex).
# Returns 0 if acquired, 1 if another live holder owns it (stdout = holder pid).
# Note: this mutex is separate from the live-ship probe used for detach refuse.
try_acquire_ship_lock() {
  local run_dir=$1
  local lock_dir="$run_dir/lock"
  local holder=""
  local holder_cmd=""
  mkdir -p "$run_dir"

  if mkdir "$lock_dir" 2>/dev/null; then
    printf '%s\n' "$$" >"$lock_dir/pid"
    printf '%s\n' "$$" >"$run_dir/playbook.pid"
    return 0
  fi

  holder=$(cat "$lock_dir/pid" 2>/dev/null || true)
  if [[ -n "$holder" && "$holder" != "$$" ]] && kill -0 "$holder" 2>/dev/null; then
    # Only refuse if the holder is still a real ship/tugboat for this dir's
    # milestone — bare kill -0 on an unrelated recycled pid is not enough.
    holder_cmd=$(tr '\0' ' ' <"/proc/$holder/cmdline" 2>/dev/null || true)
    if [[ -n "$holder_cmd" ]] && { [[ "$holder_cmd" == *tugboat* ]] || [[ "$holder_cmd" == *train* && "$holder_cmd" == *--merge* ]]; }; then
      printf '%s\n' "$holder"
      return 1
    fi
  fi

  # Stale lock only: holder missing, dead, or not a ship process.
  rm -rf "$lock_dir"
  if mkdir "$lock_dir" 2>/dev/null; then
    printf '%s\n' "$$" >"$lock_dir/pid"
    printf '%s\n' "$$" >"$run_dir/playbook.pid"
    return 0
  fi

  # Lost a race to another acquirer.
  holder=$(cat "$lock_dir/pid" 2>/dev/null || echo unknown)
  printf '%s\n' "$holder"
  return 1
}

# Find open release PR for bare version X.Y.Z (title "release: X.Y.Z …").
find_open_release_pr() {
  local ver=$1
  python3 - "$REPO_DIR" "$ver" <<'PY'
import json, subprocess, sys
repo, version = sys.argv[1], sys.argv[2]
try:
    out = subprocess.check_output(
        ["gh", "pr", "list", "--state", "open", "--json", "number,title", "--limit", "50"],
        cwd=repo, text=True,
    )
    for pr in json.loads(out):
        t = pr.get("title") or ""
        if t.startswith(f"release: {version}") or t.startswith(f"release: v{version}"):
            print(pr["number"])
            break
except Exception:
    pass
PY
}

# Emit status JSON for a bare version; never claim running without live probe.
emit_status_json() {
  local version=$1
  local run_dir state_file holder
  run_dir="$STATE_ROOT/ship-v$(safe_of "$version")"
  state_file="$run_dir/state.json"
  if [[ ! -f "$state_file" ]]; then
    echo '{"phase":"none","status":"none"}'
    return 0
  fi
  holder=""
  if holder=$(live_ship_probe "$version" 2>/dev/null); then
    # Live ship: surface state as-is (may be running).
    cat "$state_file"
    return 0
  fi
  # Not live: never claim "running" from dead pid / stale state.json alone.
  python3 - "$state_file" <<'PY'
import json, sys
path = sys.argv[1]
try:
    with open(path) as f:
        d = json.load(f)
except Exception:
    print('{"phase":"none","status":"none"}')
    raise SystemExit(0)
status = (d.get("status") or "").lower()
if status == "running":
    d["status"] = "stale"
    detail = d.get("detail") or ""
    note = "live-ship probe not live (dead pid or stale state)"
    d["detail"] = f"{detail}; {note}" if detail else note
print(json.dumps(d, separators=(",", ":"), ensure_ascii=False))
PY
}

detach_self() {
  local self
  self=$(readlink -f "$0")
  local args=()
  local m run_dir holder
  pin_repo_dir
  if [[ -z "$REPO_DIR" || ! -d "$REPO_DIR" ]]; then
    echo "FAIL: REPO_DIR required and must be a directory (got: ${REPO_DIR:-<unset>})" >&2
    exit 1
  fi
  if [[ ${#milestones[@]} -eq 1 ]]; then
    args=(--milestone "v${milestones[0]}")
  else
    args=(--milestones)
    for m in "${milestones[@]}"; do args+=("v$m"); done
  fi

  # Idempotent detach: live-ship probe ONLY may refuse a second detach (#1062).
  # Bare playbook.pid + kill -0, issue-run locks, and stale state are NOT live.
  # Buzz and TUI paste share this path — no paste detector.
  for m in "${milestones[@]}"; do
    if holder=$(live_ship_probe "$m" 2>/dev/null); then
      echo "ship v$m already running (pid $holder) — not detaching a second copy"
      emit_status_json "$m"
      notify "ship v$m already running (pid $holder) — ignored duplicate detach" "tug-dup-detach-$m-$$" --force
      return 0
    fi
  done

  nohup env PIPELINE="$PIPELINE" REPO_DIR="$REPO_DIR" ALLOW_MERGE="$ALLOW_MERGE" \
    SHIP_NOTIFY="$SHIP_NOTIFY" SHIP_NOTIFY_BIN="$SHIP_NOTIFY_BIN" \
    SHIP_STAGE_WATCH_BIN="$SHIP_STAGE_WATCH_BIN" \
    RELEASE_WAIT_ATTEMPTS="$RELEASE_WAIT_ATTEMPTS" RELEASE_WAIT_SLEEP_S="$RELEASE_WAIT_SLEEP_S" \
    ENGINE_PROMOTE_HOST="$ENGINE_PROMOTE_HOST" PIPELINE_SUPERVISOR_STATE="$STATE_ROOT" \
    RELEASE_CHECKS_GREEN_BIN="$RELEASE_CHECKS_GREEN_BIN" \
    TRAIN_STATUS_COMPLETE_BIN="$TRAIN_STATUS_COMPLETE_BIN" \
    "$self" "${args[@]}" >/dev/null 2>&1 &
  local pid=$!
  echo "detached tugboat ship ${milestones[*]} (pid $pid)"
  # Do NOT write playbook.pid here — the child acquires the lock then writes it.
  # Writing the parent/nohup pid here raced and let a second detach steal the lock.
  notify "detached ship ${milestones[*]} (pid $pid)" "tug-detach-$$" --force
}

# ---------- status / detach (before any single-milestone bind) --------------

# Pin REPO_DIR once at process start (refuse factory-control when set).
pin_repo_dir

if [[ "$do_status" == "1" ]]; then
  version=$(safe_of "${milestones[0]}")
  emit_status_json "$version"
  exit 0
fi

if [[ "$do_detach" == "1" ]]; then
  detach_self
  exit 0
fi

# ---------- preflight (shared) ----------------------------------------------

if [[ "$ALLOW_MERGE" != "1" ]]; then
  echo "FAIL: ALLOW_MERGE=$ALLOW_MERGE (need 1 for ship)" >&2
  exit 1
fi
if [[ -z "$REPO_DIR" || ! -d "$REPO_DIR" ]]; then
  echo "FAIL: REPO_DIR required and must be a directory (got: ${REPO_DIR:-<unset>})" >&2
  exit 1
fi
if [[ ! -x "$PIPELINE" ]] && ! command -v "$PIPELINE" >/dev/null 2>&1; then
  echo "FAIL: PIPELINE not executable: $PIPELINE" >&2
  exit 1
fi
if [[ ! -x "$RELEASE_CHECKS_GREEN_BIN" && ! -f "$RELEASE_CHECKS_GREEN_BIN" ]]; then
  echo "FAIL: release-checks-green helper missing: $RELEASE_CHECKS_GREEN_BIN" >&2
  exit 1
fi
if [[ ! -f "$TRAIN_STATUS_COMPLETE_BIN" ]]; then
  echo "FAIL: train-status-complete helper missing: $TRAIN_STATUS_COMPLETE_BIN" >&2
  exit 1
fi

# ---------- one milestone ship ----------------------------------------------

ship_one() {
  version=$1
  local lock_dir pr train_ec rel_ec fin_ec pro_ec ok checks_green published i draft gec cec green ver_out
  local STAGE_WATCH_PID_FILE swp SHIP_SINCE train_resumed=0 holder
  local release_lock
  release_lock() { rmdir "$lock_dir" 2>/dev/null || rm -rf "$lock_dir" 2>/dev/null || true; }

  RUN_DIR="$STATE_ROOT/ship-v$(safe_of "$version")"
  STATE_FILE="$RUN_DIR/state.json"
  LOG_FILE="$RUN_DIR/playbook.log"
  lock_dir="$RUN_DIR/lock"
  STAGE_WATCH_PID_FILE="$RUN_DIR/stage-watch.pid"
  mkdir -p "$RUN_DIR"
  touch "$LOG_FILE"
  PID=$$

  # Match fat playbook: run gh + relative paths from the ship target worktree.
  cd "$REPO_DIR"

  # Acquire lock BEFORE writing playbook.pid (never steal from a live holder).
  if ! holder=$(try_acquire_ship_lock "$RUN_DIR"); then
    # try_acquire prints holder pid on failure
    log "another tugboat holds the lock (pid ${holder:-?}) — refusing duplicate ship"
    # Do not clobber a live ship's state.json to failed.
    echo "ship v$version already running (pid ${holder:-?})" >&2
    exit 0
  fi
  trap 'release_lock' RETURN
  trap 'release_lock' EXIT

  log "tugboat start milestone=v$version version=$version repo=$REPO_DIR host=$ENGINE_PROMOTE_HOST"

  # ----- A: train + merge ---------------------------------------------------
  write_state "train" "running" "pipeline train --milestone v$version --merge --json"
  log "phase train: start"

  # Optional stage-watch for per-issue Buzz posts during train.
  if [[ -x "$SHIP_STAGE_WATCH_BIN" ]]; then
    SHIP_SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    nohup env PATH="$(dirname "$SHIP_STAGE_WATCH_BIN"):${PATH:-/usr/bin}" \
      REPO_DIR="$REPO_DIR" SHIP_NOTIFY_BIN="$SHIP_NOTIFY_BIN" \
      PIPELINE_SUPERVISOR_STATE="$STATE_ROOT" \
      "$SHIP_STAGE_WATCH_BIN" \
      --milestone "v$version" \
      --since "$SHIP_SINCE" \
      --pid-file "$STAGE_WATCH_PID_FILE" \
      >>"$RUN_DIR/stage-watch.log" 2>&1 &
    log "stage-watch started pid=$! since=$SHIP_SINCE"
  fi

  set +e
  "$PIPELINE" train --milestone "v$version" --merge --json >"$RUN_DIR/train.json" 2>"$RUN_DIR/train.stderr"
  train_ec=$?
  set -e
  [[ -s "$RUN_DIR/train.stderr" ]] && cat "$RUN_DIR/train.stderr" >>"$LOG_FILE" || true

  if [[ "$train_ec" -ne 0 ]]; then
    if grep -qi 'has no open issues' "$RUN_DIR/train.stderr" 2>/dev/null; then
      log "train: milestone has no open issues — treating as already complete (resume)"
      train_ec=0
      train_resumed=1
      write_state "train" "ok" "no open issues (already shipped)"
    elif {
      _resume_ok=0
      for _tp in "$RUN_DIR/train.complete.json" "$RUN_DIR/train.json"; do
        if [[ -s "$_tp" ]] && [[ "$(python3 "$TRAIN_STATUS_COMPLETE_BIN" "$_tp" 2>/dev/null || echo 0)" == "1" ]]; then
          _resume_ok=1
          break
        fi
      done
      [[ "$_resume_ok" -eq 1 ]]
    }; then
      log "train: prior train_status complete=true — treating as already complete (resume)"
      train_ec=0
      train_resumed=1
      write_state "train" "ok" "prior complete"
    else
      # Ensure .blocker is written when possible; prefer stderr lock/refuse text.
      python3 "$TRAIN_STATUS_COMPLETE_BIN" "$RUN_DIR/train.json" >/dev/null 2>&1 || true
      local fail_detail
      fail_detail=$(train_stderr_reason)
      if [[ -z "$fail_detail" && -f "$RUN_DIR/train.json.blocker" ]]; then
        fail_detail=$(cat "$RUN_DIR/train.json.blocker")
      fi
      if [[ -z "$fail_detail" ]]; then
        fail_detail="train exit $train_ec"
      fi
      # If sidecar is generic exit-code but stderr has the real lock line, prefer stderr.
      if [[ -f "$RUN_DIR/train.json.blocker" ]]; then
        local side
        side=$(cat "$RUN_DIR/train.json.blocker")
        if [[ "$side" =~ exited\ with\ code ]] || [[ "$side" =~ train\ exit ]]; then
          local sr
          sr=$(train_stderr_reason)
          [[ -n "$sr" ]] && fail_detail="$sr"
        fi
      fi
      write_state "train" "failed" "$fail_detail"
      log "FAIL: train exit $train_ec — $fail_detail"
      if [[ -f "$STAGE_WATCH_PID_FILE" ]]; then
        swp=$(cat "$STAGE_WATCH_PID_FILE" 2>/dev/null || true)
        if [[ -n "$swp" ]] && kill -0 "$swp" 2>/dev/null; then kill "$swp" 2>/dev/null || true; fi
      fi
      exit "$train_ec"
    fi
  fi

  # Defense in depth: on a fresh train (exit 0, not a resume), require last
  # train_status complete. Skip when we already accepted resume/no-open-issues —
  # the just-written train.json may be an error capture while train.complete.json
  # is the success artifact.
  if [[ "$train_resumed" -eq 0 && -s "$RUN_DIR/train.json" ]]; then
    ok=$(python3 "$TRAIN_STATUS_COMPLETE_BIN" "$RUN_DIR/train.json" 2>/dev/null || echo 0)
    if [[ "$ok" != "1" ]]; then
      detail="train JSON not complete"
      [[ -f "$RUN_DIR/train.json.blocker" ]] && detail=$(cat "$RUN_DIR/train.json.blocker")
      write_state "train" "failed" "$detail"
      log "FAIL: train not complete: $detail"
      if [[ -f "$STAGE_WATCH_PID_FILE" ]]; then
        swp=$(cat "$STAGE_WATCH_PID_FILE" 2>/dev/null || true)
        if [[ -n "$swp" ]] && kill -0 "$swp" 2>/dev/null; then kill "$swp" 2>/dev/null || true; fi
      fi
      exit 1
    fi
  fi

  if [[ "$train_resumed" -eq 0 ]]; then
    write_state "train" "ok" "complete"
    log "phase train: ok"
    # Keep a success artifact for resume.
    cp -f "$RUN_DIR/train.json" "$RUN_DIR/train.complete.json" 2>/dev/null || true
  else
    log "phase train: ok (resumed)"
  fi

  if [[ -f "$STAGE_WATCH_PID_FILE" ]]; then
    swp=$(cat "$STAGE_WATCH_PID_FILE" 2>/dev/null || true)
    if [[ -n "$swp" ]] && kill -0 "$swp" 2>/dev/null; then
      kill "$swp" 2>/dev/null || true
      log "stage-watch stopped pid=$swp"
    fi
  fi

  # ----- B: release prepare (bare X.Y.Z — leading v is INVALID) -------------
  write_state "release-prepare" "running" "pipeline release $version --no-edit --skip-frg"
  log "phase release-prepare: start (bare version=$version)"
  set +e
  "$PIPELINE" release "$version" --no-edit --skip-frg >"$RUN_DIR/release-prepare.out" 2>"$RUN_DIR/release-prepare.err"
  rel_ec=$?
  set -e
  cat "$RUN_DIR/release-prepare.err" >>"$LOG_FILE" 2>/dev/null || true

  pr=$(find_open_release_pr "$version")
  if [[ "$rel_ec" -ne 0 ]]; then
    if [[ -n "$pr" ]]; then
      log "phase release-prepare: existing open release PR #$pr reused (idempotent)"
    else
      write_state "release-prepare" "failed" "release exit $rel_ec; could not determine release PR number"
      log "FAIL: release exit $rel_ec; no release PR found"
      exit "$rel_ec"
    fi
  else
    if [[ -z "$pr" ]]; then
      write_state "release-prepare" "failed" "could not determine release PR number"
      log "FAIL: no release PR number after successful release"
      tail -5 "$RUN_DIR/release-prepare.out" >>"$LOG_FILE" 2>/dev/null || true
      exit 1
    fi
  fi
  write_state "release-prepare" "ok" "pr=$pr"
  log "phase release-prepare: pr=$pr"
  echo "$pr" >"$RUN_DIR/release.pr"

  # ----- B2: wait for release PR checks green (gh bucket schema) ------------
  log "phase release-finish: waiting for PR #$pr checks to go green"
  checks_green=0
  for i in $(seq 1 "$RELEASE_WAIT_ATTEMPTS"); do
    set +e
    gh pr checks "$pr" --json name,state,bucket >"$RUN_DIR/release-checks.json" 2>"$RUN_DIR/release-checks.err"
    cec=$?
    set -e
    if [[ "$cec" -ne 0 ]]; then
      log "phase release-finish: gh pr checks not available yet (attempt $i); retrying"
      sleep "$RELEASE_WAIT_SLEEP_S"
      continue
    fi
    green=$(python3 "$RELEASE_CHECKS_GREEN_BIN" "$RUN_DIR/release-checks.json")
    if [[ "$green" == "1" ]]; then
      log "phase release-finish: PR #$pr checks green (attempt $i)"
      checks_green=1
      break
    elif [[ "$green" == "-1" ]]; then
      write_state "release-finish" "failed" "PR #$pr checks failed"
      log "FAIL: release PR #$pr checks failed"
      exit 1
    else
      log "phase release-finish: PR #$pr checks not green yet (attempt $i); waiting"
      sleep "$RELEASE_WAIT_SLEEP_S"
    fi
  done
  if [[ "$checks_green" -ne 1 ]]; then
    write_state "release-finish" "failed" "PR #$pr checks not green within wait budget"
    log "FAIL: release PR #$pr checks not green in time"
    exit 1
  fi

  # ----- C: release finish --------------------------------------------------
  write_state "release-finish" "running" "pipeline release finish $pr --json"
  log "phase release-finish: start pr=$pr"
  set +e
  "$PIPELINE" release finish "$pr" --json >"$RUN_DIR/release-finish.json" 2>"$RUN_DIR/release-finish.err"
  fin_ec=$?
  set -e
  cat "$RUN_DIR/release-finish.err" >>"$LOG_FILE" 2>/dev/null || true
  if [[ "$fin_ec" -ne 0 ]]; then
    write_state "release-finish" "failed" "exit $fin_ec"
    log "FAIL: release finish exit $fin_ec"
    exit "$fin_ec"
  fi
  write_state "release-finish" "ok" "pr=$pr"
  log "phase release-finish: ok"

  # ----- D: wait for GitHub Release -----------------------------------------
  write_state "wait-release" "running" "gh release view v$version"
  log "phase wait-release: polling v$version"
  published=0
  for i in $(seq 1 "$RELEASE_WAIT_ATTEMPTS"); do
    set +e
    gh release view "v$version" --json tagName,isDraft,publishedAt >"$RUN_DIR/gh-release.json" 2>"$RUN_DIR/gh-release.err"
    gec=$?
    set -e
    if [[ "$gec" -eq 0 ]]; then
      draft=$(python3 -c 'import json; d=json.load(open("'"$RUN_DIR/gh-release.json"'")); print("1" if d.get("isDraft") else "0")')
      if [[ "$draft" == "0" ]]; then
        published=1
        log "phase wait-release: published (attempt $i)"
        break
      fi
      log "phase wait-release: draft still (attempt $i)"
    else
      log "phase wait-release: not found yet (attempt $i)"
    fi
    sleep "$RELEASE_WAIT_SLEEP_S"
  done
  if [[ "$published" -ne 1 ]]; then
    write_state "wait-release" "failed" "Release v$version not published within wait budget"
    log "FAIL: release not published in time"
    exit 1
  fi
  write_state "wait-release" "ok" "v$version published"

  # ----- E: engine-promote (all hosts by default) ---------------------------
  write_state "engine-promote" "running" "pipeline engine-promote --for $version --host $ENGINE_PROMOTE_HOST --skip-frg --json"
  log "phase engine-promote: start host=$ENGINE_PROMOTE_HOST"
  set +e
  "$PIPELINE" engine-promote --for "$version" --host "$ENGINE_PROMOTE_HOST" --skip-frg --json >"$RUN_DIR/engine-promote.json" 2>"$RUN_DIR/engine-promote.err"
  pro_ec=$?
  set -e
  cat "$RUN_DIR/engine-promote.err" >>"$LOG_FILE" 2>/dev/null || true
  if [[ "$pro_ec" -ne 0 ]]; then
    write_state "engine-promote" "failed" "exit $pro_ec"
    log "FAIL: engine-promote exit $pro_ec"
    exit "$pro_ec"
  fi
  ver_out=$("$PIPELINE" --version 2>/dev/null || echo "unknown")
  write_state "complete" "ok" "installed=$ver_out"
  log "phase engine-promote: ok installed=$ver_out"
}

# ---------- run serial multi-milestone --------------------------------------

for version in "${milestones[@]}"; do
  ship_one "$version" || exit $?
done
