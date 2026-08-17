#!/usr/bin/env bash
# Secret-free FRG pack compose helpers for Tugboat / playbook (#1039).
# Not a second pack runner. Callers invoke `pipeline factory-release prepare`.

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

def pipeline_yml_base_branch(repo_dir):
    path = os.path.join(repo_dir, ".github", "pipeline.yml")
    if not os.path.isfile(path):
        return None
    found = False
    value = None
    for line in open(path, encoding="utf-8"):
        m = re.match(
            r'^base_branch:\s*(?:["\']([^"\']+)["\']|([^\s#]+))',
            line,
        )
        if m:
            found = True
            value = (m.group(1) or m.group(2) or "").strip()
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

# Classify one factory-release prepare tick. Prints done | retry | fail.
# $1 prepare JSON path, $2 latest.json path, $3 prepare exit code.
# pass: false is pack-fail before any success status. complete is done
# only after an open release PR for the requested version is verified
# (TUGBOAT_OPEN_RELEASE_PR injects that number; else gh pr list).
classify_frg_pack_tick() {
  python3 - "$1" "$2" "$3" <<'PY'
import json, os, subprocess, sys

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

prep = load_maybe(prep_path)
latest = load_maybe(latest_path)
status = prep.get("status") if isinstance(prep, dict) else None
pass_v = latest.get("pass") if isinstance(latest, dict) else None

if pass_v is False:
    print("fail")
    raise SystemExit(0)
if pass_v is True:
    print("done")
    raise SystemExit(0)
if status == "awaiting_frg_attestation":
    print("done")
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
