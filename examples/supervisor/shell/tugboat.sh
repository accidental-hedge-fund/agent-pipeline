#!/usr/bin/env bash
# Tugboat — thin ship composer (Option 1, #1001).
#
# Ship = compose existing Pipeline CLI verbs + wait + notify. Nothing more.
#   train --milestone --merge  →  FRG pack (uncredentialed prepare +
#   factory-gate --from-run attestor)  →  release
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
#   AGENT_PIPELINE_PRODUCTION_PIN
#                          factory pin file. When unset after REPO_DIR pin,
#                          exported to $REPO_DIR/.agent-pipeline/production-engine-pin.json
#                          so engine-promote and the next train doctor share one path.
#                          An operator-set value is left unchanged.
#   PIPELINE               production-pin launcher (default: pipeline).
#                          Train --merge and engine-promote use this binary.
#                          After train-complete, FRG pack / release / finish
#                          use the candidate engine (SHIP_END_CLI), not this
#                          pin, when the pin SHA differs from the FRG-bound SHA.
#   PIPELINE_CANDIDATE_ENGINE_ROOT
#                          optional absolute candidate checkout (HEAD must
#                          equal the FRG-bound SHA, porcelain empty, and
#                          core/scripts/pipeline.ts + scripts/pipeline-launcher.mjs
#                          present). Else Tugboat uses a clean REPO_DIR HEAD
#                          or $REPO_DIR/.worktrees/ship-candidate-<sha>.
#   SHIP_END_NODE          node binary for the candidate launcher (default: node)
#   ALLOW_MERGE            must be 1 for train --merge / release finish
#   SHIP_NOTIFY            1 to post phase status (default 1)
#   SHIP_NOTIFY_BIN        notify helper (default: sibling ship-notify.sh)
#   SHIP_STAGE_WATCH_BIN   optional per-issue stage posts during train
#   RELEASE_WAIT_ATTEMPTS  CI/release wait poll attempts (default 30)
#   RELEASE_WAIT_SLEEP_S   wait sleep seconds (default 40)
#   RELEASE_CHECKS_RERUN_BUDGET  flake-eligible test reruns per head SHA (default 1, max 2)
#   RELEASE_CHECKS_FLAKE_ELIGIBLE  comma allowlist of check names (default test)
#   FRG_WAIT_ATTEMPTS      FRG pack re-invoke attempts (default RELEASE_WAIT_ATTEMPTS)
#   FRG_WAIT_SLEEP_S       FRG pack sleep seconds (default RELEASE_WAIT_SLEEP_S)
#   ENGINE_PROMOTE_HOST    promote host scope (default all)
#   TUGBOAT_SKIP_FRG       1 to skip FRG pack (requires TUGBOAT_SKIP_FRG_REASON)
#   TUGBOAT_SKIP_FRG_REASON  non-empty logged reason for skip escape
#   TUGBOAT_BASE_BRANCH    integration branch override. When unset, the
#                          request writer reads .github/pipeline.yml
#                          base_branch (same source as train/release).
#                          Missing both fails closed — origin/HEAD is not
#                          used. Slash names such as release/1.39 are kept.
#   PIPELINE_SUPERVISOR_STATE  state root
#
# Live ship (#1062): a milestone is "already running" only when a live process
# cmdline is train --merge for that milestone, or the owning tugboat for it.
# Bare playbook.pid + kill -0, per-issue pipeline N locks, and stale state.json
# alone are NOT live ships and must not refuse detach.
#
# Concurrent --detach (#1111): probe-and-spawn for one (repo, milestone) is
# serialized by a host-local flock at
# $PIPELINE_SUPERVISOR_STATE/admission/<repo-token>/vX.Y.Z.lock
# (repo-token = sha256 of pinned REPO_DIR realpath). Lock-file presence is
# not a live ship. Refuse is still live_ship_probe after the loser acquires.
#
# Version rules (hard-won):
#   train --milestone wants "vX.Y.Z"
#   release <version> wants bare "X.Y.Z" (leading v is INVALID)
#   engine-promote --for accepts bare or v (strips v)
#   gh release view wants "vX.Y.Z"
#
# State: $PIPELINE_SUPERVISOR_STATE/ship-vX.Y.Z/{state.json,playbook.log,...}
# Detach admission lock: $PIPELINE_SUPERVISOR_STATE/admission/<repo-token>/vX.Y.Z.lock
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
STATE_ROOT="${PIPELINE_SUPERVISOR_STATE:-$HOME/.local/state/pipeline-supervisor}"
# Pin snapshot of env at process start — never re-read for retarget (#1062).
REPO_DIR="${REPO_DIR:-}"
PIPELINE="${PIPELINE:-pipeline}"
SHIP_END_NODE="${SHIP_END_NODE:-node}"
# Candidate CLI for post-train FRG / release / finish. Empty until resolved.
# Never fall back to process-start $PIPELINE for those verbs (#1151).
SHIP_END_CLI=()
SHIP_END_ENGINE_ROOT=""
SHIP_END_CANDIDATE_SHA=""
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
RELEASE_CHECKS_RERUN_BUDGET="${RELEASE_CHECKS_RERUN_BUDGET:-1}"
RELEASE_CHECKS_FLAKE_ELIGIBLE="${RELEASE_CHECKS_FLAKE_ELIGIBLE:-test}"
REPO_DIR_PINNED=0
# flock wait (seconds). Loser blocks this long while the winner holds until
# live_ship_probe sees the detached child (nohup + exec on Actions).
ADMISSION_LOCK_WAIT_S="${ADMISSION_LOCK_WAIT_S:-15}"
# After setsid+nohup, poll until the child is a live ship. 50 * 0.1s = 5s.
# Expire, INT, or TERM fails closed: reap the unconfirmed child (recorded
# process group and session) before release. Do not print "detached tugboat ship".
ADMISSION_LIVE_WAIT_ATTEMPTS="${ADMISSION_LIVE_WAIT_ATTEMPTS:-50}"
ADMISSION_LIVE_WAIT_SLEEP_S="${ADMISSION_LIVE_WAIT_SLEEP_S:-0.1}"
ADMISSION_LOCK_VERSIONS=()
ADMISSION_LOCK_FDS=()
PENDING_UNCONFIRMED_PID=""
PENDING_UNCONFIRMED_PGRP=""
PENDING_UNCONFIRMED_SID=""

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
# TUGBOAT_REPOSITORY, TUGBOAT_BASE_BRANCH, TUGBOAT_FRG_MANIFEST_PATH,
# TUGBOAT_OPEN_RELEASE_PR.
# Unset candidate SHA: resolve base_branch first, then the current
# origin/<base> remote tip (ls-remote, else fetch). Never local HEAD —
# train --merge via GitHub leaves the local checkout at the pre-train SHA.
# base_branch: TUGBOAT_BASE_BRANCH, else .github/pipeline.yml (same source
# as train/release). Never origin/HEAD. Preserve slash names (release/x).
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

def normalize_branch(raw):
    raw = (raw or "").strip()
    if raw.startswith("refs/heads/"):
        raw = raw[len("refs/heads/"):]
    elif raw.startswith("refs/remotes/origin/"):
        raw = raw[len("refs/remotes/origin/"):]
    elif raw.startswith("origin/"):
        raw = raw[len("origin/"):]
    return raw

def _yaml_unquote(token):
    token = token.strip()
    if len(token) >= 2 and token[0] == token[-1] and token[0] in "'\"":
        q = token[0]
        inner = token[1:-1]
        if q == "'":
            return inner.replace("''", "'")
        out = []
        i = 0
        while i < len(inner):
            if inner[i] == "\\" and i + 1 < len(inner):
                esc = inner[i + 1]
                out.append({"n": "\n", "t": "\t", "r": "\r", "\\": "\\", '"': '"'}.get(esc, esc))
                i += 2
                continue
            out.append(inner[i])
            i += 1
        return "".join(out)
    return token

def _yaml_strip_comment(raw):
    # '#' starts a comment only after whitespace (or at column 0).
    # Keep deploy#blue; strip "staging # comment".
    in_s = in_d = False
    i = 0
    while i < len(raw):
        c = raw[i]
        if in_s:
            if c == "'" and i + 1 < len(raw) and raw[i + 1] == "'":
                i += 2
                continue
            if c == "'":
                in_s = False
            i += 1
            continue
        if in_d:
            if c == "\\" and i + 1 < len(raw):
                i += 2
                continue
            if c == '"':
                in_d = False
            i += 1
            continue
        if c == "'":
            in_s = True
        elif c == '"':
            in_d = True
        elif c == "#" and (i == 0 or raw[i - 1].isspace()):
            return raw[:i]
        i += 1
    return raw

def _yaml_key_name(raw):
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "'\"":
        return raw[1:-1]
    return raw

_TOP_PAIR = re.compile(
    r"^(?P<indent>[ \t]*)(?P<key>['\"][^'\"]+['\"]|[A-Za-z_][\w.-]*)[ \t]*:[ \t]*(?P<rest>.*)$"
)

def pipeline_yml_base_branch(repo_dir):
    # Same top-level key train/release read. Quoted keys and '#' in the
    # scalar must match YAML, not a line regex. Unsupported forms fail
    # closed instead of defaulting to main.
    path = os.path.join(repo_dir, ".github", "pipeline.yml")
    if not os.path.isfile(path):
        return None
    text = open(path, encoding="utf-8").read()
    stripped = text.lstrip()
    if stripped.startswith("{") or stripped.startswith("["):
        try:
            parsed = json.loads(text)
        except Exception:
            sys.stderr.write(
                "FAIL: unsupported flow/JSON .github/pipeline.yml base_branch; "
                "set TUGBOAT_BASE_BRANCH\n"
            )
            raise SystemExit(1)
        if isinstance(parsed, dict):
            if "base_branch" not in parsed:
                return "main"
            val = parsed.get("base_branch")
            if not isinstance(val, str):
                sys.stderr.write("FAIL: pipeline.yml base_branch must be a string\n")
                raise SystemExit(1)
            return val
        sys.stderr.write(
            "FAIL: unsupported flow .github/pipeline.yml; set TUGBOAT_BASE_BRANCH\n"
        )
        raise SystemExit(1)
    found = False
    value = None
    root_indent = None
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        m = _TOP_PAIR.match(line)
        if not m:
            if re.match(r"^[ \t]*['\"]?base_branch['\"]?", line) and ":" in line:
                sys.stderr.write(
                    "FAIL: unsupported .github/pipeline.yml base_branch syntax; "
                    "set TUGBOAT_BASE_BRANCH\n"
                )
                raise SystemExit(1)
            continue
        if root_indent is None:
            root_indent = m.group("indent")
        if _yaml_key_name(m.group("key")) != "base_branch":
            continue
        if m.group("indent") != root_indent:
            continue
        rest = _yaml_strip_comment(m.group("rest")).strip()
        if rest[:1] in "{[&*|>":
            sys.stderr.write(
                "FAIL: unsupported .github/pipeline.yml base_branch form; "
                "set TUGBOAT_BASE_BRANCH\n"
            )
            raise SystemExit(1)
        found = True
        value = _yaml_unquote(rest) if rest else ""
        break
    if not found:
        return "main"
    return value or None

base = normalize_branch(os.environ.get("TUGBOAT_BASE_BRANCH", ""))
if not base:
    base = normalize_branch(pipeline_yml_base_branch(repo) or "")
if not base:
    sys.stderr.write(
        "FAIL: base_branch is unset; set TUGBOAT_BASE_BRANCH or "
        ".github/pipeline.yml base_branch (do not guess origin/HEAD)\n"
    )
    raise SystemExit(1)
if re.search(r"\s", base):
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

# Classify one factory-release prepare tick. Prints done | attest | retry | fail.
# $1 prepare JSON path, $2 latest.json path, $3 prepare exit code,
# $4 factory-release request JSON (version + candidate SHA binding).
# pass: false is pack-fail before any success status. pass: true is
# pack-done only when latest records the request target_version and
# integrated_candidate.git_sha (and action_id when the artifact has it).
# awaiting_frg_attestation without that bound pass: true is attest, not done.
# in_progress with unsigned eligible artifacts (closed frg/unsigned digests)
# is attest so factory-gate --from-run can sign; bare in_progress is retry.
# complete is done only after an open release PR for the requested
# version is verified (TUGBOAT_OPEN_RELEASE_PR injects that number;
# else gh pr list).
classify_frg_pack_tick() {
  python3 - "$1" "$2" "$3" "${4:-}" <<'PY'
import json, os, subprocess, sys

prep_path, latest_path, ec_s = sys.argv[1], sys.argv[2], sys.argv[3]
req_path = sys.argv[4] if len(sys.argv) > 4 else ""
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

def as_dict(value):
    return value if isinstance(value, dict) else {}

def norm_ver(raw):
    v = str(raw or "").strip()
    if v.startswith("v") or v.startswith("V"):
        v = v[1:]
    return v

def norm_sha(raw):
    return str(raw or "").strip().lower()

def request_binding(req):
    if not isinstance(req, dict):
        return None
    version = norm_ver(req.get("target_version"))
    sha = norm_sha(as_dict(req.get("integrated_candidate")).get("git_sha"))
    action = str(req.get("action_id") or "").strip()
    if not version or not sha:
        return None
    return (version, sha, action)

def extract_factory_binding(latest):
    frb = latest.get("factory_release_binding")
    if isinstance(frb, dict):
        return frb
    notes = latest.get("notes")
    if isinstance(notes, list):
        prefix = "factory_release_binding:"
        for note in notes:
            if not isinstance(note, str) or not note.startswith(prefix):
                continue
            try:
                parsed = json.loads(note[len(prefix):])
            except Exception:
                continue
            if isinstance(parsed, dict):
                return parsed
    return {}

def latest_binding(latest):
    if not isinstance(latest, dict):
        return None
    frb = extract_factory_binding(latest)
    prov = as_dict(latest.get("pack_provenance"))
    version = norm_ver(
        latest.get("version") or frb.get("target_version") or prov.get("release_version")
    )
    sha = norm_sha(
        frb.get("candidate_git_sha")
        or prov.get("candidate_git_sha")
        or latest.get("candidate_git_sha")
    )
    action = str(
        frb.get("action_id") or latest.get("action_id") or prov.get("action_id") or ""
    ).strip()
    if not version or not sha:
        return None
    return (version, sha, action)

def pass_matches_request(latest, req):
    want = request_binding(req)
    got = latest_binding(latest)
    if want is None or got is None:
        return False
    if want[0] != got[0] or want[1] != got[1]:
        return False
    if got[2] and want[2] and got[2] != want[2]:
        return False
    return True

def complete_has_open_release_pr(prep):
    if not isinstance(prep, dict):
        return False
    pr = prep.get("release_pr")
    number = pr.get("number") if isinstance(pr, dict) else None
    try:
        number = int(number)
    except (TypeError, ValueError):
        return False
    if number <= 0:
        return False
    version = str(prep.get("target_version") or "").strip()
    if version.startswith("v"):
        version = version[1:]
    injected = os.environ.get("TUGBOAT_OPEN_RELEASE_PR")
    if injected is not None:
        inj = injected.strip()
        if not inj or inj.lower() in ("0", "closed", "none", "false"):
            return False
        try:
            return int(inj) == number
        except ValueError:
            return False
    repo = os.environ.get("REPO_DIR") or os.getcwd()
    try:
        out = subprocess.check_output(
            ["gh", "pr", "list", "--state", "open", "--json", "number,title", "--limit", "50"],
            cwd=repo,
            text=True,
        )
        for item in json.loads(out):
            if int(item.get("number") or 0) != number:
                continue
            title = item.get("title") or ""
            if not version:
                return True
            if title.startswith(f"release: {version}") or title.startswith(
                f"release: v{version}"
            ):
                return True
        return False
    except Exception:
        return False

def closed_artifact_ref(ref):
    if not isinstance(ref, dict):
        return False
    p = str(ref.get("path") or "").strip()
    sha = str(ref.get("sha256") or "").strip().lower()
    if not p or p == "/dev/null":
        return False
    if len(sha) != 64 or sha == "0" * 64:
        return False
    return all(c in "0123456789abcdef" for c in sha)

def unsigned_eligible_payload(payload):
    if not isinstance(payload, dict):
        return False
    return closed_artifact_ref(payload.get("observations")) and closed_artifact_ref(
        payload.get("evidence_bundle")
    )

def has_unsigned_eligible_artifacts(obj):
    if not isinstance(obj, dict):
        return False
    if unsigned_eligible_payload(obj.get("frg")):
        return True
    if unsigned_eligible_payload(obj.get("unsigned")):
        return True
    return False

prep = load_maybe(prep_path)
latest = load_maybe(latest_path)
req = load_maybe(req_path)
status = prep.get("status") if isinstance(prep, dict) else None
pass_v = latest.get("pass") if isinstance(latest, dict) else None

if pass_v is False:
    print("fail")
    raise SystemExit(0)
if pass_v is True and pass_matches_request(latest, req):
    print("done")
    raise SystemExit(0)
if status == "awaiting_frg_attestation" or (
    status == "in_progress" and has_unsigned_eligible_artifacts(prep)
):
    print("attest")
    raise SystemExit(0)
if status == "complete":
    if complete_has_open_release_pr(prep):
        print("done")
        raise SystemExit(0)
    print("fail")
    raise SystemExit(0)
if status == "in_progress":
    print("retry")
    raise SystemExit(0)
if status in ("failed", "error", "missing") or status is None or ec != 0:
    print("fail")
    raise SystemExit(0)
print("fail")
PY
}

# True when $1 is an exact 40-hex git SHA (data, not a shell fragment).
is_exact_git_sha() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]]
}

# $1 engine root, $2 want SHA. Clean HEAD match + pipeline.ts + launcher.
engine_root_ok() {
  local root=$1
  local want=$2
  local head porcelain
  [[ -d "$root" ]] || return 1
  [[ -f "$root/core/scripts/pipeline.ts" ]] || return 1
  [[ -f "$root/scripts/pipeline-launcher.mjs" ]] || return 1
  head=$(git -C "$root" rev-parse --verify HEAD 2>/dev/null | tr 'A-F' 'a-f') || return 1
  [[ "$head" == "$want" ]] || return 1
  porcelain=$(git -C "$root" status --porcelain 2>/dev/null) || return 1
  [[ -z "$porcelain" ]] || return 1
  return 0
}

# 40-hex integrated_candidate.git_sha from the factory-release request JSON.
read_candidate_sha_from_request() {
  python3 - "$1" <<'PY'
import json, re, sys
path = sys.argv[1]
try:
    req = json.load(open(path, encoding="utf-8"))
except Exception:
    sys.stderr.write("FAIL: factory-release request is not JSON\n")
    raise SystemExit(1)
if not isinstance(req, dict):
    sys.stderr.write("FAIL: factory-release request is not an object\n")
    raise SystemExit(1)
sha = str((req.get("integrated_candidate") or {}).get("git_sha") or "").strip().lower()
if not re.fullmatch(r"[0-9a-f]{40}", sha):
    sys.stderr.write("FAIL: integrated_candidate.git_sha is not an exact 40-hex SHA\n")
    raise SystemExit(1)
print(sha)
PY
}

# After train-complete: bind SHIP_END_CLI to the candidate engine. Fail closed
# (no production-pin fallback) when identity cannot be resolved (#1151).
resolve_ship_end_cli() {
  local req=$1
  local sha root launcher worktree explicit
  sha=$(read_candidate_sha_from_request "$req") || return 1
  is_exact_git_sha "$sha" || return 1
  worktree="$REPO_DIR/.worktrees/ship-candidate-$sha"
  explicit="${PIPELINE_CANDIDATE_ENGINE_ROOT:-}"
  root=""
  if engine_root_ok "$REPO_DIR" "$sha"; then
    root="$REPO_DIR"
  elif engine_root_ok "$worktree" "$sha"; then
    root="$worktree"
  elif [[ -n "$explicit" ]]; then
    case "$explicit" in
      /*) ;;
      *)
        echo "FAIL: PIPELINE_CANDIDATE_ENGINE_ROOT must be an absolute directory" >&2
        return 1
        ;;
    esac
    if engine_root_ok "$explicit" "$sha"; then
      root="$explicit"
    fi
  fi
  if [[ -z "$root" ]]; then
    mkdir -p "$REPO_DIR/.worktrees" 2>/dev/null || true
    if git -C "$REPO_DIR" fetch --quiet origin "$sha" 2>/dev/null \
      && git -C "$REPO_DIR" worktree add --detach "$worktree" "$sha" 2>/dev/null \
      && engine_root_ok "$worktree" "$sha"; then
      root="$worktree"
    fi
  fi
  if [[ -z "$root" ]]; then
    echo "FAIL: cannot resolve candidate engine at $sha (clean REPO_DIR HEAD, $worktree, or PIPELINE_CANDIDATE_ENGINE_ROOT)" >&2
    return 1
  fi
  launcher="$root/scripts/pipeline-launcher.mjs"
  SHIP_END_ENGINE_ROOT="$root"
  SHIP_END_CANDIDATE_SHA="$sha"
  SHIP_END_CLI=("$SHIP_END_NODE" "$launcher")
  if [[ -n "${RUN_DIR:-}" ]]; then
    printf '%s\n' "$launcher" >"$RUN_DIR/ship_end_cli"
    printf '%s\n' "$sha" >"$RUN_DIR/ship_end_candidate_sha"
    printf '%s\n' "$root" >"$RUN_DIR/ship_end_engine_root"
  fi
  return 0
}

# Invoke factory-release prepare with attestor env unset in THAT child.
# Parent supervisor env is left unchanged (#1133). Candidate CLI only (#1151).
invoke_factory_release_prepare() {
  local req=$1
  local out=$2
  local err=$3
  if [[ ${#SHIP_END_CLI[@]} -eq 0 ]]; then
    echo "missing_ship_end_cli" >"$err"
    return 1
  fi
  env -u PIPELINE_FRG_ATTESTATION_KEY -u PIPELINE_FRG_ATTESTATION_KEY_FILE \
    "${SHIP_END_CLI[@]}" factory-release prepare --request "$req" --json >"$out" 2>"$err"
}

# Bound pack loop_run_id from a prepare JSON result. Awaiting uses
# frg.loop_run_id; in_progress uses loop_run_id. Empty when missing.
# Do not pick an unbound newest loop.
frg_pack_loop_run_id() {
  python3 - "$1" <<'PY'
import json, os, sys

path = sys.argv[1]
if not path or not os.path.isfile(path) or os.path.getsize(path) == 0:
    print("")
    raise SystemExit(0)
text = open(path, encoding="utf-8").read().strip()
obj = None
try:
    obj = json.loads(text)
except Exception:
    i = text.rfind("{")
    if i >= 0:
        try:
            obj = json.loads(text[i:])
        except Exception:
            obj = None
if not isinstance(obj, dict):
    print("")
    raise SystemExit(0)
status = obj.get("status")
loop = ""
if status == "awaiting_frg_attestation":
    frg = obj.get("frg")
    if isinstance(frg, dict):
        loop = str(frg.get("loop_run_id") or "").strip()
elif status == "in_progress":
    loop = str(obj.get("loop_run_id") or "").strip()
print(loop)
PY
}

# factory-gate --from-run in a child other than prepare. Inherit KEY;
# when only KEY_FILE is set, present the file as KEY in that child.
# Unset KEY_FILE in the attestor child. Do not pass --observations.
# Named stderr reason + non-zero when credential or loop id is missing.
invoke_frg_pack_attestor() {
  local ver=$1
  local loop=$2
  local out=$3
  local err=$4
  if [[ ${#SHIP_END_CLI[@]} -eq 0 ]]; then
    echo "missing_ship_end_cli" >"$err"
    return 1
  fi
  if [[ -z "$loop" ]]; then
    echo "missing_loop_run_id" >"$err"
    return 1
  fi
  if [[ -n "${PIPELINE_FRG_ATTESTATION_KEY:-}" ]]; then
    env -u PIPELINE_FRG_ATTESTATION_KEY_FILE \
      "${SHIP_END_CLI[@]}" factory-gate --for "$ver" --from-run "$loop" >"$out" 2>"$err"
    return $?
  fi
  if [[ -z "${PIPELINE_FRG_ATTESTATION_KEY_FILE:-}" ]]; then
    echo "missing_attestor_credential" >"$err"
    return 1
  fi
  if [[ ! -r "$PIPELINE_FRG_ATTESTATION_KEY_FILE" ]]; then
    echo "unreadable_attestor_key_file" >"$err"
    return 1
  fi
  if [[ ! -s "$PIPELINE_FRG_ATTESTATION_KEY_FILE" ]]; then
    echo "missing_attestor_credential" >"$err"
    return 1
  fi
  PIPELINE_FRG_ATTESTATION_KEY="$(cat -- "$PIPELINE_FRG_ATTESTATION_KEY_FILE")" \
    env -u PIPELINE_FRG_ATTESTATION_KEY_FILE \
    "${SHIP_END_CLI[@]}" factory-gate --for "$ver" --from-run "$loop" >"$out" 2>"$err"
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
    release-finish)
      # Checks sidecar is the lead reason for a waiter STOP (#1110).
      # Do not prefer leftover train tester-evidence / trusted-surface warns.
      if [[ -s "$RUN_DIR/release-checks.fail.json" ]]; then
        reason=$(python3 -c 'import json,sys
try:
    d=json.load(open(sys.argv[1],encoding="utf-8"))
except Exception:
    raise SystemExit(0)
print((d.get("reason") or "")[:400])
' "$RUN_DIR/release-checks.fail.json" 2>/dev/null || true)
        if [[ -n "$reason" ]]; then
          echo "$reason"
          return
        fi
      fi
      f="$RUN_DIR/release-finish.err"
      ;;
    wait-release) f="$RUN_DIR/gh-release.err" ;;
    engine-promote) f="$RUN_DIR/engine-promote.err" ;;
    *) f="$RUN_DIR/$phase.err" ;;
  esac
  if [[ -s "$f" ]]; then
    reason=$(grep -iE 'error|fail|block|refus|denied|pending|not green|invalid|missing|cannot|could not|exit [1-9]|deadlock|lock is held|takeover' "$f" 2>/dev/null | grep -viE '^\s*-|tester-evidence|trusted-surface blocked' | tail -1)
    [[ -z "$reason" ]] && reason=$(grep -iE 'error|fail|block|refus|denied|pending|not green|invalid|missing|cannot|could not|exit [1-9]|deadlock|lock is held|takeover' "$f" 2>/dev/null | grep -viE 'tester-evidence|trusted-surface blocked' | tail -1)
    [[ -z "$reason" ]] && reason=$(tail -1 "$f" 2>/dev/null)
    echo "$reason" | sed 's/^\[pipeline[^]]*\] *//' | head -c 400
    return
  fi
  if [[ -s "$LOG_FILE" ]]; then
    reason=$(grep -iE 'lock is held|refusing takeover|another tugboat|\[pipeline[^]]*\] .*(error|fail|block|refus|denied|not green|exit [1-9]|deadlock)' "$LOG_FILE" 2>/dev/null | grep -viE 'tester-evidence|trusted-surface blocked' | tail -1)
    [[ -n "$reason" ]] && echo "$reason" | sed 's/^\[[0-9TZ:-]*\] *//' | head -c 400
  fi
}

# Shared ship-release check-wait recipe (#1110). Default 1 rerun, hard max 2.
release_checks_rerun_budget() {
  local n="${RELEASE_CHECKS_RERUN_BUDGET:-1}"
  if ! [[ "$n" =~ ^[0-9]+$ ]]; then
    n=1
  fi
  if (( n < 1 )); then n=1; fi
  if (( n > 2 )); then n=2; fi
  printf '%s\n' "$n"
}

release_pr_head_sha() {
  local pr=$1
  local sha
  sha=$(gh pr view "$pr" --json headRefOid --jq .headRefOid 2>/dev/null || true)
  printf '%s' "${sha//$'\n'/}"
}

release_checks_sidecar_field() {
  local sidecar=$1 field=$2
  python3 -c 'import json,sys
try:
    d=json.load(open(sys.argv[1],encoding="utf-8"))
except Exception:
    raise SystemExit(0)
print(d.get(sys.argv[2]) or "")
' "$sidecar" "$field" 2>/dev/null || true
}

# One poll: classify via the shared helper; on rerun record then gh run rerun --failed.
# Prints: green | pending | fail
apply_release_check_wait_tick() {
  local pr=$1
  local capture=$2
  local sidecar="$RUN_DIR/release-checks.fail.json"
  local budget_file="$RUN_DIR/release-checks.rerun"
  local failed_log="$RUN_DIR/release-checks.failed-log"
  local budget head_sha token run_id rec_ec rerun_ec

  if [[ -z "${RUN_DIR:-}" || ! -d "$RUN_DIR" ]]; then
    printf '%s\n' "fail"
    return 0
  fi
  if [[ ! -f "$capture" ]]; then
    printf '%s\n' "pending"
    return 0
  fi

  budget=$(release_checks_rerun_budget)
  head_sha=$(release_pr_head_sha "$pr")

  token=$(python3 "$RELEASE_CHECKS_GREEN_BIN" "$capture" \
    --sidecar "$sidecar" \
    --pr "$pr" \
    --head-sha "$head_sha" \
    --budget "$budget" \
    --budget-file "$budget_file" \
    --allowlist "${RELEASE_CHECKS_FLAKE_ELIGIBLE:-test}")

  if [[ "$token" == "1" ]]; then
    printf '%s\n' "green"
    return 0
  fi
  if [[ "$token" == "0" ]]; then
    printf '%s\n' "pending"
    return 0
  fi
  if [[ "$token" == "2" ]]; then
    run_id=$(release_checks_sidecar_field "$sidecar" "run_id")
    if [[ -z "$run_id" || -z "$head_sha" ]]; then
      printf '%s\n' "fail"
      return 0
    fi
    set +e
    python3 "$RELEASE_CHECKS_GREEN_BIN" --record-attempt \
      --budget-file "$budget_file" --pr "$pr" --head-sha "$head_sha" --run-id "$run_id"
    rec_ec=$?
    set -e
    if [[ "$rec_ec" -ne 0 ]]; then
      printf '%s\n' "fail"
      return 0
    fi
    set +e
    gh run rerun "$run_id" --failed
    rerun_ec=$?
    set -e
    if [[ "$rerun_ec" -ne 0 ]]; then
      printf '%s\n' "fail"
      return 0
    fi
    printf '%s\n' "pending"
    return 0
  fi

  run_id=$(release_checks_sidecar_field "$sidecar" "run_id")
  if [[ -n "$run_id" ]]; then
    set +e
    gh run view "$run_id" --log-failed >"$failed_log" 2>/dev/null
    set -e
    if [[ -s "$failed_log" ]]; then
      python3 "$RELEASE_CHECKS_GREEN_BIN" "$capture" \
        --sidecar "$sidecar" \
        --pr "$pr" \
        --head-sha "$head_sha" \
        --budget "$budget" \
        --budget-file "$budget_file" \
        --failed-log "$failed_log" \
        --allowlist "${RELEASE_CHECKS_FLAKE_ELIGIBLE:-test}" >/dev/null || true
    fi
  fi
  printf '%s\n' "fail"
  return 0
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
  export_factory_production_pin
}

# Factory pin path (#1127): promote and the next train doctor must share one file.
# Default is the control-checkout pin. Do not overwrite an operator value.
export_factory_production_pin() {
  if [[ -n "${AGENT_PIPELINE_PRODUCTION_PIN:-}" ]]; then
    return 0
  fi
  if [[ -z "${REPO_DIR:-}" ]]; then
    return 0
  fi
  export AGENT_PIPELINE_PRODUCTION_PIN="$REPO_DIR/.agent-pipeline/production-engine-pin.json"
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

# Host-local detach admission (#1111). Flock on a regular lock file serializes
# probe-and-spawn for (pinned REPO_DIR, milestone). The #1109 hole was mkdir
# detach.gate + empty-pid reclaim: two waiters both treated an unpublished pid
# as stale and both admitted. Do not reclaim on "pid file empty right now."
# Flock is the mutex. File presence is not a live ship.
repo_admission_token() {
  local hex
  if [[ -z "${REPO_DIR:-}" ]]; then
    echo "FAIL: REPO_DIR required for detach admission lock" >&2
    return 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    hex=$(printf '%s' "$REPO_DIR" | sha256sum)
    hex=${hex%% *}
  else
    echo "FAIL: sha256sum is required to key the detach admission lock" >&2
    return 1
  fi
  printf '%s\n' "$hex"
}

admission_lock_path() {
  local version=$1
  local token
  token=$(repo_admission_token) || return 1
  printf '%s\n' "$STATE_ROOT/admission/${token}/v$(safe_of "$version").lock"
}

# Same class as formatProcessIdentityMarker: "pid starttime" when readable.
admission_owner_identity() {
  local pid=$$
  local s rest
  local st=""
  if [[ -r "/proc/$pid/stat" ]]; then
    s=$(cat "/proc/$pid/stat" 2>/dev/null || true)
    rest=${s##*)}
    # After comm: $1=state (field 3) … $20=starttime (field 22).
    set -- $rest
    st=${20:-}
  fi
  if [[ -n "$st" ]]; then
    printf '%s %s\n' "$pid" "$st"
  else
    printf '%s\n' "$pid"
  fi
}

acquire_admission_lock() {
  local version=$1
  local lockfile dir fd
  if ! command -v flock >/dev/null 2>&1; then
    echo "FAIL: flock is required for detach admission (no mkdir-gate fallback)" >&2
    return 1
  fi
  lockfile=$(admission_lock_path "$version") || return 1
  dir=$(dirname "$lockfile")
  mkdir -p "$dir"
  exec {fd}>>"$lockfile" || {
    echo "FAIL: cannot open admission lock $lockfile" >&2
    return 1
  }
  if ! flock -w "$ADMISSION_LOCK_WAIT_S" "$fd"; then
    eval "exec ${fd}>&-"
    echo "FAIL: timed out waiting for detach admission lock for v$version" >&2
    return 1
  fi
  # Write identity after flock. Flock is the mutex; the write is diagnostics.
  admission_owner_identity >"$lockfile"
  ADMISSION_LOCK_VERSIONS+=("$version")
  ADMISSION_LOCK_FDS+=("$fd")
  return 0
}

release_admission_lock() {
  local version=$1
  local i fd
  if [[ ${#ADMISSION_LOCK_VERSIONS[@]} -eq 0 ]]; then
    return 0
  fi
  for i in "${!ADMISSION_LOCK_VERSIONS[@]}"; do
    if [[ "${ADMISSION_LOCK_VERSIONS[$i]}" == "$version" ]]; then
      fd="${ADMISSION_LOCK_FDS[$i]:-}"
      if [[ -n "$fd" ]]; then
        flock -u "$fd" 2>/dev/null || true
        eval "exec ${fd}>&-" 2>/dev/null || true
      fi
      unset "ADMISSION_LOCK_VERSIONS[$i]"
      unset "ADMISSION_LOCK_FDS[$i]"
      return 0
    fi
  done
  return 0
}

release_held_admission_locks() {
  local i fd
  if [[ ${#ADMISSION_LOCK_VERSIONS[@]} -eq 0 ]]; then
    return 0
  fi
  for i in "${!ADMISSION_LOCK_VERSIONS[@]}"; do
    fd="${ADMISSION_LOCK_FDS[$i]:-}"
    if [[ -n "$fd" ]]; then
      flock -u "$fd" 2>/dev/null || true
      eval "exec ${fd}>&-" 2>/dev/null || true
    fi
  done
  ADMISSION_LOCK_VERSIONS=()
  ADMISSION_LOCK_FDS=()
}

# Poll until live_ship_probe sees VERSION, or SPAWN_PID itself is a live ship.
# Bound is documented next to ADMISSION_LIVE_WAIT_* above.
wait_until_live_ship() {
  local version=$1
  local spawn_pid=${2:-}
  local i=0
  local attempts="${ADMISSION_LIVE_WAIT_ATTEMPTS:-50}"
  local sleep_s="${ADMISSION_LIVE_WAIT_SLEEP_S:-0.1}"
  while [[ "$i" -lt "$attempts" ]]; do
    if live_ship_probe "$version" >/dev/null 2>&1; then
      return 0
    fi
    if [[ -n "$spawn_pid" ]] && kill -0 "$spawn_pid" 2>/dev/null \
      && read_proc_argv "$spawn_pid" \
      && argv_is_live_ship "$version" "${__proc_argv[@]}"; then
      return 0
    fi
    sleep "$sleep_s"
    i=$((i + 1))
  done
  return 1
}

# Record the just-spawned detach child so EXIT/INT/TERM can reap it before
# unlocking. After setsid, pid == pgrp == session; /proc is the source if it
# has already forked a new group in that same session.
record_pending_unconfirmed_child() {
  local spawn_pid=${1:-}
  local s rest pgrp sid self_pgrp="" self_sid=""
  # setsid makes pid == pgrp == session. Keep those defaults if /proc still
  # shows our own group (setsid has not completed) so we never record self.
  PENDING_UNCONFIRMED_PID=$spawn_pid
  PENDING_UNCONFIRMED_PGRP=$spawn_pid
  PENDING_UNCONFIRMED_SID=$spawn_pid
  [[ -n "$spawn_pid" ]] || return 0
  if [[ -r /proc/self/stat ]]; then
    s=$(cat /proc/self/stat 2>/dev/null || true)
    rest=${s##*)}
    set -- $rest
    self_pgrp=${3:-}
    self_sid=${4:-}
  fi
  if [[ -r "/proc/$spawn_pid/stat" ]]; then
    s=$(cat "/proc/$spawn_pid/stat" 2>/dev/null || true)
    rest=${s##*)}
    set -- $rest
    pgrp=${3:-}
    sid=${4:-}
    if [[ -n "$pgrp" && "$pgrp" != "0" && "$pgrp" != "$self_pgrp" ]]; then
      PENDING_UNCONFIRMED_PGRP=$pgrp
    fi
    if [[ -n "$sid" && "$sid" != "0" && "$sid" != "$self_sid" ]]; then
      PENDING_UNCONFIRMED_SID=$sid
    fi
  fi
}

clear_pending_unconfirmed_child() {
  PENDING_UNCONFIRMED_PID=""
  PENDING_UNCONFIRMED_PGRP=""
  PENDING_UNCONFIRMED_SID=""
}

# Reap any still-unconfirmed child, then drop flock. Idempotent for EXIT after
# INT/TERM. Must not unlock while an unconfirmed descendant can still become live.
cleanup_detach_admission() {
  local pid pgrp sid
  pid=${PENDING_UNCONFIRMED_PID:-}
  pgrp=${PENDING_UNCONFIRMED_PGRP:-}
  sid=${PENDING_UNCONFIRMED_SID:-}
  clear_pending_unconfirmed_child
  if [[ -n "$pid" ]]; then
    reap_unconfirmed_detach_child "$pid" "$pgrp" "$sid"
  fi
  release_held_admission_locks
}

# Terminate a spawned detach child that never became a live ship. Must run
# while admission is still held so a later detach cannot stack a second ship.
# Signals the recorded process group and session (survives intermediate-parent
# exit / re-parent) plus SPAWN_PID and remaining /proc descendants. Does not
# signal this process's own group or session.
reap_unconfirmed_detach_child() {
  local spawn_pid=${1:-}
  local spawn_pgrp=${2:-}
  local spawn_sid=${3:-}
  local self=$$
  local self_pgrp="" self_sid="" s rest ppid pgrp sid p dir match
  local i=0
  [[ -n "$spawn_pid" && "$spawn_pid" != "$self" ]] || return 0

  if [[ -r /proc/self/stat ]]; then
    s=$(cat /proc/self/stat 2>/dev/null || true)
    rest=${s##*)}
    set -- $rest
    self_pgrp=${3:-}
    self_sid=${4:-}
  fi
  if [[ -n "$spawn_pgrp" && "$spawn_pgrp" == "$self_pgrp" ]]; then
    spawn_pgrp=""
  fi
  if [[ -n "$spawn_sid" && "$spawn_sid" == "$self_sid" ]]; then
    spawn_sid=""
  fi

  if [[ -n "$spawn_pgrp" ]]; then
    kill -TERM -- "-$spawn_pgrp" 2>/dev/null || true
  fi
  kill -TERM "$spawn_pid" 2>/dev/null || true
  shopt -s nullglob
  for dir in /proc/[0-9]*; do
    p=${dir#/proc/}
    [[ "$p" != "$self" ]] || continue
    [[ -r "/proc/$p/stat" ]] || continue
    s=$(cat "/proc/$p/stat" 2>/dev/null || true)
    rest=${s##*)}
    set -- $rest
    ppid=${2:-}
    pgrp=${3:-}
    sid=${4:-}
    match=0
    if [[ "$p" == "$spawn_pid" || "$ppid" == "$spawn_pid" ]]; then
      match=1
    elif [[ -n "$spawn_pgrp" && "$pgrp" == "$spawn_pgrp" ]]; then
      match=1
    elif [[ -n "$spawn_sid" && "$sid" == "$spawn_sid" ]]; then
      match=1
    fi
    if [[ "$match" -eq 1 ]]; then
      if [[ -n "$pgrp" && "$pgrp" != "$self_pgrp" ]]; then
        kill -TERM -- "-$pgrp" 2>/dev/null || true
      elif [[ "$p" != "$spawn_pid" ]]; then
        kill -TERM "$p" 2>/dev/null || true
      fi
    fi
  done

  while [[ "$i" -lt 20 ]]; do
    kill -0 "$spawn_pid" 2>/dev/null || break
    sleep 0.05
    i=$((i + 1))
  done

  if [[ -n "$spawn_pgrp" ]]; then
    kill -KILL -- "-$spawn_pgrp" 2>/dev/null || true
  fi
  kill -KILL "$spawn_pid" 2>/dev/null || true
  for dir in /proc/[0-9]*; do
    p=${dir#/proc/}
    [[ "$p" != "$self" ]] || continue
    [[ -r "/proc/$p/stat" ]] || continue
    s=$(cat "/proc/$p/stat" 2>/dev/null || true)
    rest=${s##*)}
    set -- $rest
    ppid=${2:-}
    pgrp=${3:-}
    sid=${4:-}
    match=0
    if [[ "$p" == "$spawn_pid" || "$ppid" == "$spawn_pid" ]]; then
      match=1
    elif [[ -n "$spawn_pgrp" && "$pgrp" == "$spawn_pgrp" ]]; then
      match=1
    elif [[ -n "$spawn_sid" && "$sid" == "$spawn_sid" ]]; then
      match=1
    fi
    if [[ "$match" -eq 1 ]]; then
      if [[ -n "$pgrp" && "$pgrp" != "$self_pgrp" ]]; then
        kill -KILL -- "-$pgrp" 2>/dev/null || true
      fi
      kill -KILL "$p" 2>/dev/null || true
    fi
  done
  wait "$spawn_pid" 2>/dev/null || true
  # A child can _exit after fork before the descendant is visible in /proc.
  # One more session scan after a short wait catches that re-parent.
  sleep 0.05
  for dir in /proc/[0-9]*; do
    p=${dir#/proc/}
    [[ "$p" != "$self" ]] || continue
    [[ -r "/proc/$p/stat" ]] || continue
    s=$(cat "/proc/$p/stat" 2>/dev/null || true)
    rest=${s##*)}
    set -- $rest
    pgrp=${3:-}
    sid=${4:-}
    if [[ -n "$spawn_sid" && "$sid" == "$spawn_sid" ]] \
      || [[ -n "$spawn_pgrp" && "$pgrp" == "$spawn_pgrp" ]]; then
      if [[ -n "$pgrp" && "$pgrp" != "$self_pgrp" ]]; then
        kill -KILL -- "-$pgrp" 2>/dev/null || true
      fi
      kill -KILL "$p" 2>/dev/null || true
    fi
  done
  return 0
}

# Find open release PR for bare version X.Y.Z (title "release: X.Y.Z …").
# Re-Ship / release finish after a prior waiter STOP still reuses this PR (#1110).
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
  # Serialize probe-and-spawn with a host-local flock on
  # $STATE_ROOT/admission/<repo-token>/v<milestone>.lock so two concurrent
  # Ship requests cannot both observe not-live and stack detached tugboats.
  # The loser waits, then re-probes. Lock-file presence is not already-running
  # (#1111). Hold flock until live_ship_probe sees the child.
  # Reap any still-unconfirmed child before unlock on RETURN/EXIT/INT/TERM.
  trap 'cleanup_detach_admission' RETURN
  trap 'cleanup_detach_admission' EXIT
  trap 'cleanup_detach_admission; exit 130' INT
  trap 'cleanup_detach_admission; exit 143' TERM

  for m in "${milestones[@]}"; do
    if ! acquire_admission_lock "$m"; then
      # Wait timeout: re-probe; if live, refuse as duplicate. Else fail closed
      # rather than risk stacking another detached tugboat.
      if holder=$(live_ship_probe "$m" 2>/dev/null); then
        echo "ship v$m already running (pid $holder) — not detaching a second copy"
        emit_status_json "$m"
        notify "ship v$m already running (pid $holder) — ignored duplicate detach" "tug-dup-detach-$m-$$" --force
        return 0
      fi
      echo "FAIL: timed out waiting for detach admission lock for v$m" >&2
      exit 1
    fi
  done

  for m in "${milestones[@]}"; do
    if holder=$(live_ship_probe "$m" 2>/dev/null); then
      echo "ship v$m already running (pid $holder) — not detaching a second copy"
      emit_status_json "$m"
      notify "ship v$m already running (pid $holder) — ignored duplicate detach" "tug-dup-detach-$m-$$" --force
      return 0
    fi
  done

  if ! command -v setsid >/dev/null 2>&1; then
    echo "FAIL: setsid is required to isolate the detached child process group" >&2
    exit 1
  fi

  # Dedicated session/process group so cleanup can kill the whole tree after
  # an intermediate parent exits (re-parented descendants keep this session).
  setsid nohup env PIPELINE="$PIPELINE" REPO_DIR="$REPO_DIR" ALLOW_MERGE="$ALLOW_MERGE" \
    SHIP_NOTIFY="$SHIP_NOTIFY" SHIP_NOTIFY_BIN="$SHIP_NOTIFY_BIN" \
    SHIP_STAGE_WATCH_BIN="$SHIP_STAGE_WATCH_BIN" \
    RELEASE_WAIT_ATTEMPTS="$RELEASE_WAIT_ATTEMPTS" RELEASE_WAIT_SLEEP_S="$RELEASE_WAIT_SLEEP_S" \
    FRG_WAIT_ATTEMPTS="$FRG_WAIT_ATTEMPTS" FRG_WAIT_SLEEP_S="$FRG_WAIT_SLEEP_S" \
    ENGINE_PROMOTE_HOST="$ENGINE_PROMOTE_HOST" PIPELINE_SUPERVISOR_STATE="$STATE_ROOT" \
    RELEASE_CHECKS_GREEN_BIN="$RELEASE_CHECKS_GREEN_BIN" \
    TRAIN_STATUS_COMPLETE_BIN="$TRAIN_STATUS_COMPLETE_BIN" \
    AGENT_PIPELINE_PRODUCTION_PIN="${AGENT_PIPELINE_PRODUCTION_PIN:-}" \
    TUGBOAT_SKIP_FRG="$SKIP_FRG" TUGBOAT_SKIP_FRG_REASON="$SKIP_FRG_REASON" \
    TUGBOAT_CANDIDATE_SHA="${TUGBOAT_CANDIDATE_SHA:-}" \
    TUGBOAT_REPOSITORY="${TUGBOAT_REPOSITORY:-}" \
    TUGBOAT_BASE_BRANCH="${TUGBOAT_BASE_BRANCH:-}" \
    TUGBOAT_FRG_MANIFEST_PATH="${TUGBOAT_FRG_MANIFEST_PATH:-}" \
    "$self" "${args[@]}" >/dev/null 2>&1 &
  pid=$!
  record_pending_unconfirmed_child "$pid"
  # Do NOT write playbook.pid here — the child acquires the lock then writes it.
  # Writing the parent/nohup pid here raced and let a second detach steal the lock.

  if ! kill -0 "$pid" 2>/dev/null; then
    echo "FAIL: tugboat detach spawn failed for v${milestones[0]}" >&2
    exit 1
  fi

  # Hold flock until the new ship is visible to live_ship_probe (or bound).
  # Emit "detached tugboat ship" only after that probe succeeds.
  if ! wait_until_live_ship "${milestones[0]}" "$pid"; then
    echo "FAIL: detached child did not become a live ship for v${milestones[0]}" >&2
    # Reap before EXIT releases admission. A slow child must not become live
    # after the lock drops and admit a second ship (#1111).
    reap_unconfirmed_detach_child "$pid" \
      "${PENDING_UNCONFIRMED_PGRP:-}" "${PENDING_UNCONFIRMED_SID:-}"
    clear_pending_unconfirmed_child
    exit 1
  fi

  clear_pending_unconfirmed_child
  echo "detached tugboat ship ${milestones[*]} (pid $pid)"
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
export_factory_production_pin
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

  # ----- A1b: resolve candidate engine for ship-end (no pin fallback) ------
  local req pack_done pack_ec pack_verdict latest_json loop_id attest_ec attest_reason
  req="$RUN_DIR/factory-release-prepare-request.json"
  if ! write_factory_release_request "$req" "$version" "$REPO_DIR"; then
    write_state "frg-pack" "failed" "could not write factory-release prepare request"
    log "FAIL: could not write factory-release prepare request"
    exit 1
  fi
  if ! resolve_ship_end_cli "$req"; then
    write_state "frg-pack" "failed" "candidate-engine identity defect"
    log "FAIL: candidate-engine identity defect — will not fall back to production-pin \$PIPELINE"
    exit 1
  fi
  log "phase ship-end-cli: engine=$SHIP_END_ENGINE_ROOT sha=$SHIP_END_CANDIDATE_SHA"

  # ----- A2: FRG pack (uncredentialed prepare + out-of-process attestor) ---
  if [[ "$SKIP_FRG" != "1" ]]; then
    write_state "frg-pack" "running" "pipeline factory-release prepare --request $req --json"
    log "phase frg-pack: start request=$req"
    pack_done=0
    latest_json="$REPO_DIR/.agent-pipeline/frg/$version/latest.json"
    for i in $(seq 1 "$FRG_WAIT_ATTEMPTS"); do
      set +e
      invoke_factory_release_prepare "$req" "$RUN_DIR/frg-pack.json" "$RUN_DIR/frg-pack.err"
      pack_ec=$?
      set -e
      cat "$RUN_DIR/frg-pack.err" >>"$LOG_FILE" 2>/dev/null || true
      pack_verdict=$(classify_frg_pack_tick "$RUN_DIR/frg-pack.json" "$latest_json" "$pack_ec" "$req")
      if [[ "$pack_verdict" == "done" ]]; then
        log "phase frg-pack: pack-done (attempt $i)"
        pack_done=1
        break
      elif [[ "$pack_verdict" == "attest" ]]; then
        loop_id=$(frg_pack_loop_run_id "$RUN_DIR/frg-pack.json")
        if [[ -z "$loop_id" ]]; then
          write_state "frg-pack" "failed" "FRG pack failed (missing_loop_run_id)"
          log "FAIL: FRG pack failed (attempt $i) missing_loop_run_id"
          exit 1
        fi
        log "phase frg-pack: attest factory-gate --for $version --from-run $loop_id (attempt $i)"
        set +e
        invoke_frg_pack_attestor "$version" "$loop_id" "$RUN_DIR/frg-attest.json" "$RUN_DIR/frg-attest.err"
        attest_ec=$?
        set -e
        cat "$RUN_DIR/frg-attest.err" >>"$LOG_FILE" 2>/dev/null || true
        if [[ "$attest_ec" -ne 0 ]]; then
          attest_reason=$(tail -1 "$RUN_DIR/frg-attest.err" 2>/dev/null || true)
          [[ -z "$attest_reason" ]] && attest_reason="attestor child"
          write_state "frg-pack" "failed" "FRG pack failed ($attest_reason)"
          log "FAIL: FRG pack failed (attempt $i) $attest_reason"
          exit 1
        fi
        pack_verdict=$(classify_frg_pack_tick "$RUN_DIR/frg-pack.json" "$latest_json" "$pack_ec" "$req")
        if [[ "$pack_verdict" == "done" ]]; then
          log "phase frg-pack: pack-done after attest (attempt $i)"
          pack_done=1
          break
        fi
        write_state "frg-pack" "failed" "FRG pack failed (attestor did not write bound latest.json)"
        log "FAIL: FRG pack failed (attempt $i) attestor did not write bound latest.json"
        exit 1
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
  "${SHIP_END_CLI[@]}" release "$version" --no-edit "${SKIP_FRG_ARGS[@]}" >"$RUN_DIR/release-prepare.out" 2>"$RUN_DIR/release-prepare.err"
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

  # ----- B2: wait for release PR checks green (shared #1110 recipe) ---------
  log "phase release-finish: waiting for PR #$pr checks to go green"
  checks_green=0
  for i in $(seq 1 "$RELEASE_WAIT_ATTEMPTS"); do
    set +e
    gh pr checks "$pr" --json name,state,bucket,link >"$RUN_DIR/release-checks.json" 2>"$RUN_DIR/release-checks.err"
    cec=$?
    set -e
    if [[ "$cec" -ne 0 ]]; then
      log "phase release-finish: gh pr checks not available yet (attempt $i); retrying"
      sleep "$RELEASE_WAIT_SLEEP_S"
      continue
    fi
    verdict=$(apply_release_check_wait_tick "$pr" "$RUN_DIR/release-checks.json")
    if [[ "$verdict" == "green" ]]; then
      log "phase release-finish: PR #$pr checks green (attempt $i)"
      checks_green=1
      break
    elif [[ "$verdict" == "fail" ]]; then
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
  "${SHIP_END_CLI[@]}" release finish "$pr" --json >"$RUN_DIR/release-finish.json" 2>"$RUN_DIR/release-finish.err"
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
