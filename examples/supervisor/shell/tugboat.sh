#!/usr/bin/env bash
# Tugboat — thin ship composer (Option 1, #1001).
#
# Ship = compose existing Pipeline CLI verbs + wait + notify. Nothing more.
#   train --milestone --merge  →  release  →  wait CI green  →  release finish
#   →  wait GitHub Release  →  engine-promote --host all
#
# No train-completion JSON archaeology, no second merge policy, no grant
# factory, no `pipeline ship` subcommand, no parallel "ship brain".
# The Pipeline engine owns every decision; Tugboat sequences and reports.
#
# Usage:
#   tugboat.sh --milestone v1.37.0 [--detach]
#   tugboat.sh --milestone v1.37.0 --status
#
# Environment:
#   REPO_DIR            worktree (required)
#   PIPELINE            pipeline launcher (default: pipeline)
#   ALLOW_MERGE         must be 1 for train --merge / release finish
#   SHIP_NOTIFY         1 to post phase status (default 1)
#   SHIP_NOTIFY_BIN     notify helper (default: sibling ship-notify.sh)
#   RELEASE_WAIT_ATTEMPTS  CI-wait poll attempts (default 30)
#   RELEASE_WAIT_SLEEP_S   CI-wait sleep seconds (default 40)
#   ENGINE_PROMOTE_HOST    promote host scope (default all)
#
# State: $PIPELINE_SUPERVISOR_STATE/ship-<milestone>/{state.json,playbook.log,...}
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
STATE_ROOT="${PIPELINE_SUPERVISOR_STATE:-$HOME/.local/state/pipeline-supervisor}"
REPO_DIR="${REPO_DIR:-}"
PIPELINE="${PIPELINE:-pipeline}"
ALLOW_MERGE="${ALLOW_MERGE:-0}"
SHIP_NOTIFY="${SHIP_NOTIFY:-1}"
SHIP_NOTIFY_BIN="${SHIP_NOTIFY_BIN:-$SCRIPT_DIR/ship-notify.sh}"
RELEASE_WAIT_ATTEMPTS="${RELEASE_WAIT_ATTEMPTS:-30}"
RELEASE_WAIT_SLEEP_S="${RELEASE_WAIT_SLEEP_S:-40}"
ENGINE_PROMOTE_HOST="${ENGINE_PROMOTE_HOST:-all}"
RELEASE_CHECKS_GREEN_BIN="${RELEASE_CHECKS_GREEN_BIN:-$SCRIPT_DIR/release-checks-green.py}"

milestone=""
do_detach=0
do_status=0

usage() {
  cat <<'USAGE'
Usage:
  tugboat.sh --milestone vX.Y.Z [--detach]
  tugboat.sh --milestone vX.Y.Z --status
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --milestone|-m)
      [[ -n "${2:-}" ]] || { echo "missing value for $1" >&2; exit 2; }
      milestone=${2#v}
      shift 2
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

[[ -n "$milestone" ]] || { usage; exit 2; }

# ---------- helpers ---------------------------------------------------------

json_str() {
  python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"
}

safe_of() {
  echo "$1" | tr 'A-Z' 'a-z'
}

log() {
  local line="[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"
  echo "$line" >>"$LOG_FILE"
  echo "$line"
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
  "milestone": $(json_str "$milestone"),
  "version": $(json_str "$milestone"),
  "phase": $(json_str "$phase"),
  "status": $(json_str "$status"),
  "detail": $(json_str "$detail"),
  "updated_at": "$now",
  "log": $(json_str "$LOG_FILE"),
  "pid": $$
}
JSON
  local msg="ship v$milestone: ${phase} → ${status}"
  [[ -n "$detail" ]] && msg="${msg} (${detail})"
  notify "$msg" "tug-$(safe_of "$milestone")-${phase}-${status}-$$-$(date +%s)" --force
}

failure_detail() {
  local phase=$1
  local f reason
  case "$phase" in
    train)
      if [[ -s "$RUN_DIR/train.json.blocker" ]]; then
        cat "$RUN_DIR/train.json.blocker" 2>/dev/null | head -c 300
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
    reason=$(grep -iE 'error|fail|block|refus|denied|pending|not green|invalid|missing|cannot|could not|exit [1-9]' "$f" 2>/dev/null | grep -viE '^\s*-' | tail -1)
    [[ -z "$reason" ]] && reason=$(grep -iE 'error|fail|block|refus|denied|pending|not green|invalid|missing|cannot|could not|exit [1-9]' "$f" 2>/dev/null | tail -1)
    [[ -z "$reason" ]] && reason=$(tail -1 "$f" 2>/dev/null)
    echo "$reason" | sed 's/^\[pipeline[^]]*\] *//' | head -c 400
    return
  fi
  if [[ -s "$LOG_FILE" ]]; then
    reason=$(grep -iE '\[pipeline[^]]*\] .*(error|fail|block|refus|denied|not green|exit [1-9])' "$LOG_FILE" 2>/dev/null | tail -1)
    [[ -n "$reason" ]] && echo "$reason" | sed 's/^\[[0-9TZ:-]*\] *//' | head -c 400
  fi
}

detach_self() {
  local self
  self=$(readlink -f "$0")
  nohup env PIPELINE="$PIPELINE" REPO_DIR="$REPO_DIR" ALLOW_MERGE="$ALLOW_MERGE" \
    SHIP_NOTIFY="$SHIP_NOTIFY" SHIP_NOTIFY_BIN="$SHIP_NOTIFY_BIN" \
    RELEASE_WAIT_ATTEMPTS="$RELEASE_WAIT_ATTEMPTS" RELEASE_WAIT_SLEEP_S="$RELEASE_WAIT_SLEEP_S" \
    ENGINE_PROMOTE_HOST="$ENGINE_PROMOTE_HOST" PIPELINE_SUPERVISOR_STATE="$STATE_ROOT" \
    "$self" --milestone "v$milestone" >/dev/null 2>&1 &
  echo "detached tugboat ship v$milestone (pid $!)"
}

# ---------- setup -----------------------------------------------------------

RUN_DIR="$STATE_ROOT/ship-v$(safe_of "$milestone")"
STATE_FILE="$RUN_DIR/state.json"
LOG_FILE="$RUN_DIR/playbook.log"
mkdir -p "$RUN_DIR"
touch "$LOG_FILE"

if [[ "$do_status" == "1" ]]; then
  [[ -f "$STATE_FILE" ]] || { echo '{"phase":"none","status":"none"}'; exit 0; }
  cat "$STATE_FILE"
  exit 0
fi

if [[ "$do_detach" == "1" ]]; then
  detach_self
  exit 0
fi

# ---------- preflight -------------------------------------------------------

if [[ "$ALLOW_MERGE" != "1" ]]; then
  write_state "precheck" "failed" "ALLOW_MERGE is not 1"
  log "FAIL: ALLOW_MERGE=$ALLOW_MERGE (need 1 for ship)"
  exit 1
fi
if [[ -z "$REPO_DIR" || ! -d "$REPO_DIR" ]]; then
  write_state "precheck" "failed" "REPO_DIR missing or not a directory: ${REPO_DIR:-<unset>}"
  log "FAIL: REPO_DIR required"
  exit 1
fi

# ---------- A: train + merge ------------------------------------------------

write_state "train" "running" "pipeline train --milestone v$milestone --merge --json"
log "phase train: start"
set +e
"$PIPELINE" train --milestone "v$milestone" --merge --json >"$RUN_DIR/train.json" 2>"$RUN_DIR/train.stderr"
train_ec=$?
set -e
if [[ "$train_ec" -ne 0 ]]; then
  # If the last train_status says complete with no blocker, treat as already
  # shipped (resume) — the pipeline itself owns that determination.
  ok=$(python3 "$SCRIPT_DIR/train-status-complete.py" "$RUN_DIR/train.json" 2>/dev/null || echo 0)
  if [[ "$ok" == "1" ]]; then
    write_state "train" "ok" "prior complete"
    log "phase train: prior train_status complete=true — resume"
  else
    if [[ -f "$RUN_DIR/train.json.blocker" ]]; then
      write_state "train" "failed" "$(cat "$RUN_DIR/train.json.blocker")"
    else
      write_state "train" "failed" "train exit $train_ec"
    fi
    log "FAIL: train exit $train_ec"
    exit "$train_ec"
  fi
fi
write_state "train" "ok" "complete"
log "phase train: ok"

# ---------- B: release prepare (idempotent) ---------------------------------

write_state "release-prepare" "running" "pipeline release v$milestone --no-edit --skip-frg"
log "phase release-prepare: start"
set +e
"$PIPELINE" release "v$milestone" --no-edit --skip-frg >"$RUN_DIR/release-prepare.out" 2>"$RUN_DIR/release-prepare.err"
rel_ec=$?
set -e
if [[ "$rel_ec" -ne 0 ]]; then
  # If an open release PR for this version already exists, reuse it instead of
  # failing (idempotent resume) — never open a duplicate.
  pr=$(python3 - "$REPO_DIR" "$milestone" <<'PY'
import json, subprocess, sys
repo, version = sys.argv[1], sys.argv[2]
try:
    out = subprocess.check_output(
        ["gh", "pr", "list", "--state", "open", "--json", "number,title", "--limit", "50"],
        cwd=repo, text=True,
    )
    for pr in json.loads(out):
        if pr.get("title", "").startswith(f"release: {version}") or pr.get("title", "").startswith(f"release: v{version}"):
            print(pr["number"])
            break
except Exception:
    pass
PY
  )
  if [[ -n "$pr" ]]; then
    log "phase release-prepare: existing open release PR #$pr reused (idempotent)"
  else
    write_state "release-prepare" "failed" "release exit $rel_ec; could not determine release PR number"
    log "FAIL: release exit $rel_ec; no release PR found"
    cat "$RUN_DIR/release-prepare.err" >>"$LOG_FILE" 2>/dev/null || true
    exit "$rel_ec"
  fi
else
  pr=$(python3 - "$REPO_DIR" "$milestone" <<'PY'
import json, subprocess, sys
repo, version = sys.argv[1], sys.argv[2]
try:
    out = subprocess.check_output(
        ["gh", "pr", "list", "--state", "open", "--json", "number,title", "--limit", "50"],
        cwd=repo, text=True,
    )
    for pr in json.loads(out):
        if pr.get("title", "").startswith(f"release: {version}") or pr.get("title", "").startswith(f"release: v{version}"):
            print(pr["number"])
            break
except Exception:
    pass
PY
  )
  if [[ -z "$pr" ]]; then
    write_state "release-prepare" "failed" "could not determine release PR number"
    log "FAIL: no release PR number; release out/err:"
    tail -5 "$RUN_DIR/release-prepare.out" >>"$LOG_FILE" 2>/dev/null || true
    tail -5 "$RUN_DIR/release-prepare.err" >>"$LOG_FILE" 2>/dev/null || true
    exit 1
  fi
fi
write_state "release-prepare" "ok" "pr=$pr"
log "phase release-prepare: pr=$pr"
echo "$pr" >"$RUN_DIR/release.pr"

# ---------- B2: wait for release PR checks green ----------------------------

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

# ---------- C: release finish -----------------------------------------------

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

# ---------- D: wait for GitHub Release --------------------------------------

write_state "wait-release" "running" "gh release view v$milestone"
log "phase wait-release: polling v$milestone"
published=0
for i in $(seq 1 "$RELEASE_WAIT_ATTEMPTS"); do
  set +e
  gh release view "v$milestone" --json tagName,isDraft,publishedAt >"$RUN_DIR/gh-release.json" 2>"$RUN_DIR/gh-release.err"
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
  write_state "wait-release" "failed" "Release v$milestone not published within wait budget"
  log "FAIL: release not published in time"
  exit 1
fi
write_state "wait-release" "ok" "v$milestone published"

# ---------- E: engine-promote (all hosts) -----------------------------------

write_state "engine-promote" "running" "pipeline engine-promote --for $milestone --host $ENGINE_PROMOTE_HOST --skip-frg --json"
log "phase engine-promote: start"
set +e
"$PIPELINE" engine-promote --for "$milestone" --host "$ENGINE_PROMOTE_HOST" --skip-frg --json >"$RUN_DIR/engine-promote.json" 2>"$RUN_DIR/engine-promote.err"
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
