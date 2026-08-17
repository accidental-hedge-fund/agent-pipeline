#!/usr/bin/env bash
# Tugboat — thin ship composer (Option 1, #1001).
#
# Ship = compose existing Pipeline CLI verbs + wait + notify. Nothing more.
#   train --milestone --merge  →  FRG pack (factory-release prepare)  →  release
#   →  wait CI green  →  release finish  →  wait GitHub Release  →
#   engine-promote --host all
# Default release / promote argv omit --skip-frg. Skip is an operator escape
# with a logged reason (--skip-frg / TUGBOAT_SKIP_FRG + reason).
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
#   FRG_WAIT_ATTEMPTS      FRG pack re-invoke attempts (default RELEASE_WAIT_ATTEMPTS)
#   FRG_WAIT_SLEEP_S       FRG pack sleep seconds (default RELEASE_WAIT_SLEEP_S)
#   ENGINE_PROMOTE_HOST    promote host scope (default all)
#   TUGBOAT_SKIP_FRG       1 to skip FRG pack (requires TUGBOAT_SKIP_FRG_REASON)
#   TUGBOAT_SKIP_FRG_REASON  non-empty logged reason for skip escape
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
FRG_WAIT_ATTEMPTS="${FRG_WAIT_ATTEMPTS:-$RELEASE_WAIT_ATTEMPTS}"
FRG_WAIT_SLEEP_S="${FRG_WAIT_SLEEP_S:-$RELEASE_WAIT_SLEEP_S}"
ENGINE_PROMOTE_HOST="${ENGINE_PROMOTE_HOST:-all}"
RELEASE_CHECKS_GREEN_BIN="${RELEASE_CHECKS_GREEN_BIN:-$SCRIPT_DIR/release-checks-green.py}"
TRAIN_STATUS_COMPLETE_BIN="${TRAIN_STATUS_COMPLETE_BIN:-$SCRIPT_DIR/train-status-complete.py}"
REPO_DIR_PINNED=0

milestones=()
do_detach=0
do_status=0
flag_skip_frg=0
flag_skip_frg_reason=""
SKIP_FRG=0
SKIP_FRG_REASON=""

usage() {
  cat <<'USAGE'
Usage:
  tugboat.sh --milestone vX.Y.Z [--detach]
  tugboat.sh --milestones vA.B.C vD.E.F [--detach]   # serial; promote after each
  tugboat.sh --milestone vX.Y.Z --status
  tugboat.sh --milestone vX.Y.Z --skip-frg --skip-frg-reason "<reason>"
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
    --skip-frg)
      flag_skip_frg=1
      shift
      ;;
    --skip-frg-reason)
      [[ -n "${2:-}" ]] || { echo "missing value for $1" >&2; exit 2; }
      flag_skip_frg_reason=$2
      shift 2
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

# Operator escape: --skip-frg or TUGBOAT_SKIP_FRG=1 requires a non-empty reason.
# Fail closed before any ship mutation when skip is requested without a reason.
# Status does not call this.
resolve_skip_frg() {
  local want_skip=0
  local reason=""
  SKIP_FRG=0
  SKIP_FRG_REASON=""
  [[ "$flag_skip_frg" == "1" ]] && want_skip=1
  [[ "${TUGBOAT_SKIP_FRG:-}" == "1" ]] && want_skip=1
  reason="${flag_skip_frg_reason:-}"
  [[ -z "$reason" ]] && reason="${TUGBOAT_SKIP_FRG_REASON:-}"
  reason=$(printf '%s' "$reason" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  if [[ "$want_skip" == "1" ]]; then
    if [[ -z "$reason" ]]; then
      echo "FAIL: --skip-frg / TUGBOAT_SKIP_FRG requires a non-empty --skip-frg-reason or TUGBOAT_SKIP_FRG_REASON" >&2
      exit 1
    fi
    SKIP_FRG=1
    SKIP_FRG_REASON="$reason"
  fi
}

# Secret-free factory_release_prepare_request bound to ship coordinates.
# dest=$1 version=$2 repo_dir=$3. Tests inject TUGBOAT_CANDIDATE_SHA,
# TUGBOAT_REPOSITORY, TUGBOAT_BASE_BRANCH, TUGBOAT_FRG_MANIFEST_PATH.
# Unset candidate SHA: resolve base_branch first, then the current
# origin/<base> remote tip (ls-remote, else fetch). Never local HEAD —
# train --merge via GitHub leaves the local checkout at the pre-train SHA.
# Inlined so ~/.local/bin/tugboat stays self-contained. Keep in sync with
# examples/supervisor/shell/frg-pack-helpers.sh (playbook source).
write_factory_release_request() {
  local dest=$1
  local ver=$2
  local repo=$3
  python3 - "$dest" "$ver" "$repo" <<'PY'
import hashlib, json, os, re, subprocess, sys

dest, version, repo = sys.argv[1], sys.argv[2], sys.argv[3]
forbidden = {
    "pass", "status", "metrics", "metric", "receipt", "evidence_receipt",
    "attestation_key", "attestation_key_path", "PIPELINE_FRG_ATTESTATION_KEY",
    "credential", "credentials", "executable", "module", "command",
    "network_target", "signer_path", "private_key", "secret",
}

manifest = os.environ.get("TUGBOAT_FRG_MANIFEST_PATH") or os.path.join(
    repo, "core", "scripts", "frg-packs", "factory-gate-v1", "manifest.json"
)
if not os.path.isfile(manifest):
    sys.stderr.write(f"FAIL: FRG pack manifest missing: {manifest}\n")
    raise SystemExit(1)
raw = open(manifest, "rb").read()
sha = hashlib.sha256(raw).hexdigest()
try:
    pack = json.loads(raw.decode())
except Exception as exc:
    sys.stderr.write(f"FAIL: FRG pack manifest is not valid JSON: {exc}\n")
    raise SystemExit(1)
pack_id = pack.get("pack_id") or "factory-gate-v1"

repo_id = os.environ.get("TUGBOAT_REPOSITORY", "").strip().lower()
if not repo_id:
    try:
        repo_id = subprocess.check_output(
            ["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
            cwd=repo,
            text=True,
        ).strip().lower()
    except Exception:
        url = subprocess.check_output(
            ["git", "-C", repo, "remote", "get-url", "origin"], text=True
        ).strip()
        m = re.search(r"[:/]([^/]+/[^/]+?)(?:\.git)?$", url)
        repo_id = (m.group(1) if m else "").lower()
if not re.fullmatch(r"[a-z0-9_.-]+/[a-z0-9_.-]+", repo_id):
    sys.stderr.write("FAIL: repository identity is missing (owner/repo)\n")
    raise SystemExit(1)

base = os.environ.get("TUGBOAT_BASE_BRANCH", "").strip()
if not base:
    try:
        ref = subprocess.check_output(
            ["git", "-C", repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
            text=True,
        ).strip()
        base = ref.split("/")[-1] if ref else "main"
    except Exception:
        base = "main"
if not base or re.search(r"\s", base):
    sys.stderr.write("FAIL: base_branch is empty or contains whitespace\n")
    raise SystemExit(1)

# Bind the live origin/<base> tip after train. Local HEAD stays at the
# pre-train SHA when train merges through GitHub.
git_sha = os.environ.get("TUGBOAT_CANDIDATE_SHA", "").strip().lower()
if not git_sha:
    try:
        out = subprocess.check_output(
            ["git", "-C", repo, "ls-remote", "--exit-code", "origin", f"refs/heads/{base}"],
            text=True,
        ).strip()
        git_sha = (out.split()[0] if out else "").strip().lower()
    except Exception:
        git_sha = ""
    if not git_sha:
        try:
            subprocess.check_output(
                ["git", "-C", repo, "fetch", "--quiet", "origin", f"{base}:refs/remotes/origin/{base}"],
                text=True,
            )
            git_sha = subprocess.check_output(
                ["git", "-C", repo, "rev-parse", "--verify", f"refs/remotes/origin/{base}"],
                text=True,
            ).strip().lower()
        except Exception:
            git_sha = ""
if not re.fullmatch(r"[0-9a-f]{40,64}", git_sha):
    sys.stderr.write(
        "FAIL: integrated_candidate.git_sha is not a git object id "
        f"(need TUGBOAT_CANDIDATE_SHA or origin/{base} tip after train)\n"
    )
    raise SystemExit(1)

req = {
    "schema_version": 1,
    "kind": "factory_release_prepare_request",
    "action_id": f"tugboat-ship-{version}",
    "repository": repo_id,
    "base_branch": base,
    "target_version": version,
    "integrated_candidate": {"git_sha": git_sha},
    "frg_manifest": {"pack_id": pack_id, "sha256": sha},
}
for key in req:
    if key in forbidden:
        sys.stderr.write(f"FAIL: request must not contain forbidden field {key}\n")
        raise SystemExit(1)

os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
with open(dest, "w", encoding="utf-8") as fh:
    json.dump(req, fh, indent=2)
    fh.write("\n")
print(dest)
PY
}

# Classify one factory-release prepare tick. Prints done | retry | fail.
# $1 prepare JSON path, $2 latest.json path, $3 prepare exit code.
classify_frg_pack_tick() {
  python3 - "$1" "$2" "$3" <<'PY'
import json, os, sys

prep_path, latest_path, ec_s = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    ec = int(ec_s)
except ValueError:
    ec = 1

def load_maybe(path):
    if not path or not os.path.isfile(path) or os.path.getsize(path) == 0:
        return None
    text = open(path, encoding="utf-8").read().strip()
    try:
        return json.loads(text)
    except Exception:
        i = text.rfind("{")
        if i >= 0:
            try:
                return json.loads(text[i:])
            except Exception:
                return None
        return None

prep = load_maybe(prep_path)
latest = load_maybe(latest_path)
status = prep.get("status") if isinstance(prep, dict) else None
pass_v = latest.get("pass") if isinstance(latest, dict) else None

if pass_v is True:
    print("done")
    raise SystemExit(0)
if status == "awaiting_frg_attestation":
    print("done")
    raise SystemExit(0)
if status == "complete":
    print("done")
    raise SystemExit(0)
if status == "in_progress":
    print("retry")
    raise SystemExit(0)
if pass_v is False:
    print("fail")
    raise SystemExit(0)
if status in ("failed", "error", "missing") or status is None or ec != 0:
    print("fail")
    raise SystemExit(0)
print("fail")
PY
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
    frg-pack) f="$RUN_DIR/frg-pack.err" ;;
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

# Live ship = structured argv match only (#1062 R2): exact argument boundaries
# from NUL-delimited /proc/<pid>/cmdline — never flattened substring search.
# Live = Pipeline train with positional train + exact --merge + milestone option,
# OR owning tugboat for that milestone (not --status / not --detach launcher).
# Does NOT treat bare playbook.pid, issue-run locks, or spoofed single-arg text.

# Read /proc/pid/cmdline into __proc_argv (NUL-delimited). Return 1 if empty.
read_proc_argv() {
  local pid=$1
  __proc_argv=()
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  mapfile -d '' -t __proc_argv <"/proc/$pid/cmdline" 2>/dev/null || return 1
  while [[ ${#__proc_argv[@]} -gt 0 && -z "${__proc_argv[-1]}" ]]; do
    unset '__proc_argv[-1]'
  done
  [[ ${#__proc_argv[@]} -gt 0 ]] || return 1
  return 0
}

# Pure: argv_is_live_ship VERSION ARG... — exact token match for bare X.Y.Z.
argv_is_live_ship() {
  local version=$1
  shift
  local -a argv=("$@")
  local tag="v${version}"
  local i arg base next j m
  local has_train=0 has_merge=0 has_milestone=0
  local is_tugboat=0 has_status=0 has_detach=0
  local has_pipeline_entry=0

  [[ ${#argv[@]} -gt 0 ]] || return 1

  for ((i = 0; i < ${#argv[@]}; i++)); do
    arg="${argv[i]}"
    base="${arg##*/}"
    case "$base" in
      tugboat|tugboat.sh) is_tugboat=1 ;;
      *tugboat*) is_tugboat=1 ;;
      pipeline|pipeline.sh|pipeline.mjs|pipeline.js|pipeline.ts) has_pipeline_entry=1 ;;
    esac
    # node /path/to/pipeline.mjs (entrypoint is the next arg)
    if [[ "$base" == "node" || "$base" == "nodejs" ]]; then
      next="${argv[i + 1]:-}"
      case "${next##*/}" in
        pipeline|pipeline.sh|pipeline.mjs|pipeline.js|pipeline.ts) has_pipeline_entry=1 ;;
      esac
    fi
    [[ "$arg" == "train" ]] && has_train=1
    [[ "$arg" == "--merge" ]] && has_merge=1
    [[ "$arg" == "--status" ]] && has_status=1
    [[ "$arg" == "--detach" ]] && has_detach=1
    if [[ "$arg" == "--milestone" || "$arg" == "-m" ]]; then
      next="${argv[i + 1]:-}"
      if [[ "$next" == "$tag" || "$next" == "$version" ]]; then
        has_milestone=1
      fi
    fi
    if [[ "$arg" == "--milestones" ]]; then
      for ((j = i + 1; j < ${#argv[@]}; j++)); do
        m="${argv[j]}"
        [[ "$m" == --* ]] && break
        if [[ "$m" == "$tag" || "$m" == "$version" ]]; then
          has_milestone=1
        fi
      done
    fi
  done

  # Owning tugboat: basename tugboat, exact milestone option, not status/detach.
  if [[ $is_tugboat -eq 1 && $has_status -eq 0 && $has_detach -eq 0 && $has_milestone -eq 1 ]]; then
    return 0
  fi

  # Pipeline train ship: exact positional train + exact --merge + milestone
  # option/value, with a pipeline entrypoint (or node + pipeline script).
  if [[ $has_pipeline_entry -eq 1 && $has_train -eq 1 && $has_merge -eq 1 && $has_milestone -eq 1 ]]; then
    return 0
  fi
  return 1
}

# Back-compat pure helper for tests that pass a single flattened string.
# Word-splits for convenience only — production probe uses read_proc_argv.
cmdline_is_live_ship() {
  local cmdline=$1
  local version=$2
  local -a words=()
  # shellcheck disable=SC2206
  words=($cmdline)
  argv_is_live_ship "$version" "${words[@]}"
}

# Live-ship probe: scan host process argv (NUL-delimited). Fails open to
# "not live" when /proc is unreadable (never false-refuse on bare pid files).
# Prints matching pid on stdout when live; return 0 live / 1 not live.
# version = bare X.Y.Z (no leading v).
live_ship_probe() {
  local version=$1
  local pid
  local self=$$
  shopt -s nullglob
  for dir in /proc/[0-9]*; do
    pid=${dir#/proc/}
    [[ "$pid" == "$self" ]] && continue
    read_proc_argv "$pid" || continue
    if argv_is_live_ship "$version" "${__proc_argv[@]}"; then
      printf '%s\n' "$pid"
      return 0
    fi
  done
  return 1
}

# Single-host milestone lock. Lock dir is the mutex; lock/pid is the holder.
# NEVER write playbook.pid before winning the lock (that race stole the mutex).
# Returns 0 if acquired, 1 if another live holder owns it (stdout = holder pid).
# version = bare X.Y.Z (no leading v) — same milestone coordinate as the run_dir.
# Holder retention uses argv_is_live_ship for THAT version only: a live
# train/tugboat for a different milestone (stale/recycled lock pid) is reclaimed.
# Note: this mutex is separate from the live-ship probe used for detach refuse.
try_acquire_ship_lock() {
  local run_dir=$1
  local version=$2
  local lock_dir="$run_dir/lock"
  local holder=""
  mkdir -p "$run_dir"

  if mkdir "$lock_dir" 2>/dev/null; then
    printf '%s\n' "$$" >"$lock_dir/pid"
    printf '%s\n' "$$" >"$run_dir/playbook.pid"
    return 0
  fi

  holder=$(cat "$lock_dir/pid" 2>/dev/null || true)
  if [[ -n "$holder" && "$holder" != "$$" ]] && kill -0 "$holder" 2>/dev/null; then
    # Only refuse if the holder is still a live ship for THIS milestone —
    # bare kill -0, or a live train/tugboat for another milestone, is reclaimed.
    if read_proc_argv "$holder" && argv_is_live_ship "$version" "${__proc_argv[@]}"; then
      printf '%s\n' "$holder"
      return 1
    fi
  fi

  # Stale lock: holder missing, dead, wrong-milestone ship, or not a ship process.
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

# Short-lived host mutex: serializes probe-and-spawn for one milestone so
# concurrent Ship requests cannot both pass not-live and stack detached
# tugboats. Refusing a second ship is still based on live_ship_probe while
# holding the gate — not on gate presence alone (#1062 R2).
try_acquire_detach_gate() {
  local version=$1
  local dir gate holder
  local i
  dir="$STATE_ROOT/ship-v$(safe_of "$version")"
  gate="$dir/detach.gate"
  mkdir -p "$dir"
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 \
           21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 \
           41 42 43 44 45 46 47 48 49 50; do
    if mkdir "$gate" 2>/dev/null; then
      printf '%s\n' "$$" >"$gate/pid"
      return 0
    fi
    holder=$(cat "$gate/pid" 2>/dev/null || true)
    if [[ -z "$holder" ]] || ! kill -0 "$holder" 2>/dev/null; then
      rm -rf "$gate" 2>/dev/null || true
      continue
    fi
    sleep 0.1
  done
  return 1
}

release_detach_gate() {
  local version=$1
  local gate="$STATE_ROOT/ship-v$(safe_of "$version")/detach.gate"
  local holder
  holder=$(cat "$gate/pid" 2>/dev/null || true)
  if [[ -z "$holder" || "$holder" == "$$" ]]; then
    rm -rf "$gate" 2>/dev/null || true
  fi
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
  local m holder pid
  local -a gates=()
  local _wait
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
  #
  # Serialize probe-and-spawn with a short-lived per-milestone detach.gate so
  # two concurrent Ship requests cannot both observe not-live and stack
  # detached tugboats. Second request is refused only when re-probe is live
  # while holding the gate — not merely because the gate exists (#1062 R2).
  release_held_detach_gates() {
    local g
    for g in "${gates[@]}"; do
      release_detach_gate "$g"
    done
    gates=()
  }

  for m in "${milestones[@]}"; do
    if ! try_acquire_detach_gate "$m"; then
      # Gate timeout: re-probe; if live, refuse as duplicate. Else fail closed
      # rather than risk stacking another detached tugboat.
      if holder=$(live_ship_probe "$m" 2>/dev/null); then
        release_held_detach_gates
        echo "ship v$m already running (pid $holder) — not detaching a second copy"
        emit_status_json "$m"
        notify "ship v$m already running (pid $holder) — ignored duplicate detach" "tug-dup-detach-$m-$$" --force
        return 0
      fi
      release_held_detach_gates
      echo "FAIL: could not acquire detach gate for v$m (concurrent ship in progress?)" >&2
      exit 1
    fi
    gates+=("$m")
  done

  for m in "${milestones[@]}"; do
    if holder=$(live_ship_probe "$m" 2>/dev/null); then
      release_held_detach_gates
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
    FRG_WAIT_ATTEMPTS="$FRG_WAIT_ATTEMPTS" FRG_WAIT_SLEEP_S="$FRG_WAIT_SLEEP_S" \
    ENGINE_PROMOTE_HOST="$ENGINE_PROMOTE_HOST" PIPELINE_SUPERVISOR_STATE="$STATE_ROOT" \
    RELEASE_CHECKS_GREEN_BIN="$RELEASE_CHECKS_GREEN_BIN" \
    TRAIN_STATUS_COMPLETE_BIN="$TRAIN_STATUS_COMPLETE_BIN" \
    TUGBOAT_SKIP_FRG="$SKIP_FRG" TUGBOAT_SKIP_FRG_REASON="$SKIP_FRG_REASON" \
    TUGBOAT_CANDIDATE_SHA="${TUGBOAT_CANDIDATE_SHA:-}" \
    TUGBOAT_REPOSITORY="${TUGBOAT_REPOSITORY:-}" \
    TUGBOAT_BASE_BRANCH="${TUGBOAT_BASE_BRANCH:-}" \
    TUGBOAT_FRG_MANIFEST_PATH="${TUGBOAT_FRG_MANIFEST_PATH:-}" \
    "$self" "${args[@]}" >/dev/null 2>&1 &
  pid=$!
  echo "detached tugboat ship ${milestones[*]} (pid $pid)"
  # Do NOT write playbook.pid here — the child acquires the lock then writes it.
  # Writing the parent/nohup pid here raced and let a second detach steal the lock.

  # Hold gate until the new ship is visible to live_ship_probe (or brief timeout)
  # so a concurrent waiter re-probes after we release and sees live.
  for _wait in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if live_ship_probe "${milestones[0]}" >/dev/null 2>&1; then
      break
    fi
    if kill -0 "$pid" 2>/dev/null && read_proc_argv "$pid" \
      && argv_is_live_ship "${milestones[0]}" "${__proc_argv[@]}"; then
      break
    fi
    sleep 0.05
  done

  notify "detached ship ${milestones[*]} (pid $pid)" "tug-detach-$$" --force
  release_held_detach_gates
}

# ---------- status / detach (before any single-milestone bind) --------------

# Pin REPO_DIR once at process start (refuse factory-control when set).
pin_repo_dir

if [[ "$do_status" == "1" ]]; then
  version=$(safe_of "${milestones[0]}")
  emit_status_json "$version"
  exit 0
fi

# Skip escape is validated before detach or any train/release mutation.
resolve_skip_frg

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
  # Pass version so a recycled lock pid for another milestone is reclaimed.
  if ! holder=$(try_acquire_ship_lock "$RUN_DIR" "$version"); then
    # try_acquire prints holder pid on failure
    log "another tugboat holds the lock (pid ${holder:-?}) — refusing duplicate ship"
    # Do not clobber a live ship's state.json to failed.
    echo "ship v$version already running (pid ${holder:-?})" >&2
    exit 0
  fi
  trap 'release_lock' RETURN
  trap 'release_lock' EXIT

  log "tugboat start milestone=v$version version=$version repo=$REPO_DIR host=$ENGINE_PROMOTE_HOST"
  SKIP_FRG_ARGS=()
  if [[ "$SKIP_FRG" == "1" ]]; then
    SKIP_FRG_ARGS=(--skip-frg)
    printf '%s\n' "$SKIP_FRG_REASON" >"$RUN_DIR/skip-frg-reason.txt"
    log "skip-frg escape reason=$SKIP_FRG_REASON"
  fi

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

  # ----- A2: FRG pack (compose factory-release prepare; no second runner) ---
  if [[ "$SKIP_FRG" != "1" ]]; then
    local req pack_done pack_ec pack_verdict latest_json
    req="$RUN_DIR/factory-release-prepare-request.json"
    write_state "frg-pack" "running" "pipeline factory-release prepare --request $req --json"
    log "phase frg-pack: start request=$req"
    if ! write_factory_release_request "$req" "$version" "$REPO_DIR"; then
      write_state "frg-pack" "failed" "could not write factory-release prepare request"
      log "FAIL: could not write factory-release prepare request"
      exit 1
    fi
    pack_done=0
    latest_json="$REPO_DIR/.agent-pipeline/frg/$version/latest.json"
    for i in $(seq 1 "$FRG_WAIT_ATTEMPTS"); do
      set +e
      "$PIPELINE" factory-release prepare --request "$req" --json >"$RUN_DIR/frg-pack.json" 2>"$RUN_DIR/frg-pack.err"
      pack_ec=$?
      set -e
      cat "$RUN_DIR/frg-pack.err" >>"$LOG_FILE" 2>/dev/null || true
      pack_verdict=$(classify_frg_pack_tick "$RUN_DIR/frg-pack.json" "$latest_json" "$pack_ec")
      if [[ "$pack_verdict" == "done" ]]; then
        log "phase frg-pack: pack-done (attempt $i)"
        pack_done=1
        break
      elif [[ "$pack_verdict" == "retry" ]]; then
        log "phase frg-pack: in_progress (attempt $i); waiting"
        sleep "$FRG_WAIT_SLEEP_S"
      else
        write_state "frg-pack" "failed" "FRG pack failed (prepare status or latest.json)"
        log "FAIL: FRG pack failed (attempt $i)"
        exit 1
      fi
    done
    if [[ "$pack_done" -ne 1 ]]; then
      write_state "frg-pack" "failed" "FRG pack still in_progress within wait budget"
      log "FAIL: FRG pack still in_progress within wait budget"
      exit 1
    fi
    write_state "frg-pack" "ok" "pack-done"
    log "phase frg-pack: ok"
  else
    log "phase frg-pack: omitted (skip-frg escape)"
  fi

  # ----- B: release prepare (bare X.Y.Z — leading v is INVALID) -------------
  write_state "release-prepare" "running" "pipeline release $version --no-edit ${SKIP_FRG_ARGS[*]}"
  log "phase release-prepare: start (bare version=$version)"
  set +e
  "$PIPELINE" release "$version" --no-edit "${SKIP_FRG_ARGS[@]}" >"$RUN_DIR/release-prepare.out" 2>"$RUN_DIR/release-prepare.err"
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
  write_state "engine-promote" "running" "pipeline engine-promote --for $version --host $ENGINE_PROMOTE_HOST ${SKIP_FRG_ARGS[*]} --json"
  log "phase engine-promote: start host=$ENGINE_PROMOTE_HOST"
  set +e
  "$PIPELINE" engine-promote --for "$version" --host "$ENGINE_PROMOTE_HOST" "${SKIP_FRG_ARGS[@]}" --json >"$RUN_DIR/engine-promote.json" 2>"$RUN_DIR/engine-promote.err"
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
