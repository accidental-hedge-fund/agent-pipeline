#!/usr/bin/env bash
# Secret-free FRG pack compose helpers for Tugboat / playbook (#1039 / #1133).
# Not a second pack runner. Callers invoke uncredentialed
# `pipeline factory-release prepare`, then (when unsigned) credentialed
# `pipeline factory-gate --from-run` in a separate child.

# dest=$1 version=$2 repo_dir=$3. Tests inject TUGBOAT_CANDIDATE_SHA,
# TUGBOAT_REPOSITORY, TUGBOAT_BASE_BRANCH, TUGBOAT_FRG_MANIFEST_PATH,
# TUGBOAT_OPEN_RELEASE_PR.
# Unset candidate SHA: resolve base_branch first, then the current
# origin/<base> remote tip (ls-remote, else fetch). Never local HEAD.
# base_branch: TUGBOAT_BASE_BRANCH, else .github/pipeline.yml (same source
# as train/release). Never origin/HEAD. Preserve slash names (release/x).
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

# Bound pack loop is live when lock.json pid is alive or ledger/events are not
# terminal. Not live when lock pid is dead or missing AND ledger is terminal or
# missing. Prints 1, 0, or unknown. Unreadable or malformed lock/ledger is
# unknown, not 0. Never kills the pid. $1 = prepare loop_run_id.
frg_pack_loop_is_live() {
  python3 - "${1:-}" <<'PY'
import json, os, re, sys

loop_id = sys.argv[1].strip() if len(sys.argv) > 1 else ""
safe = re.compile(r"^[A-Za-z0-9._-]+$")
if not loop_id or not safe.match(loop_id) or loop_id in (".", "..") or ".." in loop_id:
    print("0")
    raise SystemExit(0)

home = os.environ.get("AGENT_PIPELINE_STATE_HOME") or os.environ.get("PIPELINE_STATE_HOME")
if home:
    home = os.path.abspath(home)
elif os.environ.get("XDG_STATE_HOME"):
    home = os.path.join(os.path.abspath(os.environ["XDG_STATE_HOME"]), "agent-pipeline", "loop")
else:
    home = os.path.join(os.path.expanduser("~"), ".local", "state", "agent-pipeline", "loop")

run_dir = os.path.join(home, "runs", loop_id)
lock_path = os.path.join(run_dir, "lock.json")
ledger_path = os.path.join(run_dir, "ledger.json")
events_path = os.path.join(run_dir, "events.jsonl")

def read_text(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return ("ok", fh.read())
    except FileNotFoundError:
        return ("missing", "")
    except (OSError, UnicodeError):
        return ("unreadable", "")

pid_alive = False
lock_unreadable = False
lock_status, lock_text = read_text(lock_path)
if lock_status == "unreadable":
    lock_unreadable = True
elif lock_status == "ok":
    try:
        obj = json.loads(lock_text)
        pid = obj.get("pid") if isinstance(obj, dict) else None
        if isinstance(pid, bool):
            pid = None
        if isinstance(pid, str) and pid.isdigit():
            pid = int(pid)
        if isinstance(pid, int) and not isinstance(pid, bool) and pid > 0:
            try:
                os.kill(pid, 0)
                pid_alive = True
            except ProcessLookupError:
                pid_alive = False
            except PermissionError:
                pid_alive = True
            except OSError as exc:
                pid_alive = getattr(exc, "errno", None) == 1
        else:
            lock_unreadable = True
    except Exception:
        lock_unreadable = True

if pid_alive:
    print("1")
    raise SystemExit(0)

STOP_REASONS = frozenset((
    "recovery_exhausted",
    "consecutive_blocked",
    "needs_human_classification",
    "repeated_no_progress",
    "human_authority",
    "run_fatal",
    "supervisor_no_progress",
    "supervisor_cycle_cap",
    "dependency_deadlock",
    "worktree_capacity",
))

def parse_ledger_stop(raw):
    if raw is None:
        return "open"
    if not isinstance(raw, dict):
        return "invalid"
    reason = raw.get("reason")
    time = raw.get("time")
    if not isinstance(reason, str) or reason not in STOP_REASONS:
        return "invalid"
    if not isinstance(time, str) or not time:
        return "invalid"
    ready = raw.get("outstanding_ready")
    if ready is not None:
        if not isinstance(ready, list) or any(not isinstance(x, str) for x in ready):
            return "invalid"
    return "stop"

ledger_present = False
ledger_stop = False
ledger_unreadable = False
ledger_status, ledger_text = read_text(ledger_path)
if ledger_status == "unreadable":
    ledger_unreadable = True
elif ledger_status == "ok":
    if not ledger_text.strip():
        ledger_unreadable = True
    else:
        try:
            ledger = json.loads(ledger_text)
            if isinstance(ledger, dict):
                stop = ledger.get("stop") if "stop" in ledger else None
                stop_kind = parse_ledger_stop(stop)
                if stop_kind == "invalid":
                    ledger_unreadable = True
                else:
                    ledger_present = True
                    ledger_stop = stop_kind == "stop"
            else:
                ledger_unreadable = True
        except Exception:
            ledger_unreadable = True

events_terminal = False
if os.path.isfile(events_path):
    try:
        for line in open(events_path, encoding="utf-8"):
            text = line.strip()
            if not text:
                continue
            try:
                ev = json.loads(text)
            except Exception:
                continue
            kind = ""
            if isinstance(ev, dict):
                kind = str(ev.get("kind") or ev.get("type") or "")
            if kind in ("loop_run_complete", "loop_run_stopped", "run_complete"):
                events_terminal = True
                break
    except Exception:
        events_terminal = False

if ledger_present and not ledger_stop and not events_terminal:
    print("1")
    raise SystemExit(0)
if lock_unreadable or ledger_unreadable:
    print("unknown")
    raise SystemExit(0)
print("0")
PY
}

# Wait-continue vs wait-fail. $1 tick (retry|done|attest|fail) $2 live (1|0|unknown)
# $3 attempt (1-based) $4 numeric cap. retry + live or unknown continues even at cap.
frg_pack_wait_decision() {
  local tick=${1:-}
  local live=${2:-0}
  local attempt=${3:-0}
  local cap=${4:-0}
  if [[ "$tick" != "retry" ]]; then
    printf '%s\n' "continue"
    return 0
  fi
  if [[ "$live" == "1" || "$live" == "unknown" ]]; then
    printf '%s\n' "continue"
    return 0
  fi
  if [[ "$attempt" =~ ^[0-9]+$ && "$cap" =~ ^[0-9]+$ && "$attempt" -lt "$cap" ]]; then
    printf '%s\n' "continue"
    return 0
  fi
  printf '%s\n' "fail"
}
