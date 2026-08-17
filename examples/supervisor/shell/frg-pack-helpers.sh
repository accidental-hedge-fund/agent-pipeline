#!/usr/bin/env bash
# Secret-free FRG pack compose helpers for Tugboat / playbook (#1039).
# Not a second pack runner. Callers invoke `pipeline factory-release prepare`.

# dest=$1 version=$2 repo_dir=$3. Tests inject TUGBOAT_CANDIDATE_SHA,
# TUGBOAT_REPOSITORY, TUGBOAT_BASE_BRANCH, TUGBOAT_FRG_MANIFEST_PATH.
# Unset candidate SHA: resolve base_branch first, then the current
# origin/<base> remote tip (ls-remote, else fetch). Never local HEAD.
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
