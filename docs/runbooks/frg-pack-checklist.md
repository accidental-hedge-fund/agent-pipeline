# FRG pack checklist (operator)

**Goal:** produce `.agent-pipeline/frg/<X.Y.Z>/latest.json` so  
`pipeline release <X.Y.Z>` and the ship playbook release phase can proceed.

**Authoritative runbook:** [factory-reliability-gate-runbook.md](../factory-reliability-gate-runbook.md)  
If this checklist conflicts with the runbook, **the runbook wins**.

**Ship tooling:** [ship-milestone.md](./ship-milestone.md) and  
`examples/supervisor/shell/ship-milestone.sh`.

---

## 0. Preconditions

- [ ] Control (or release) checkout clean on the intended base branch
- [ ] `pipeline doctor --json` green enough to run pack loops
- [ ] `gh` auth OK; `ALLOW_MERGE=1` only if the pack may open/close synthetic PRs
- [ ] Product backlog train (if any) is already done or orthogonal — **do not** use a product work-list train run as `--from-run`

## 1. Fixed pack selector (not product backlog)

FRG must score a **fixed pack**, for example:

- label **`factory-gate`**, or  
- milestone **`factory-gate`** / **`frg-pack`** / **`reliability-pack`**

Pack content: recovery/composition scenarios from the FRG runbook — **not**  
“ship remaining product issues.”

- [ ] Pack issues/PRs exist and match the selector  
- [ ] Prefer low concurrency for capacity scenarios when exercising capacity

## 2. Run the pack

```bash
export REPO_DIR=/path/to/control-checkout
export PIPELINE=pipeline   # or absolute launcher
cd "$REPO_DIR"

# One item:
pipeline single <pack-issue>

# Multi-item:
pipeline loop --label factory-gate
# or: pipeline loop --milestone factory-gate
```

- [ ] Record **loop run id** from handoff JSON /  
  `~/.local/state/agent-pipeline/loop/runs/loop-*`

## 3. Score FRG for the version

```bash
cd "$REPO_DIR"
pipeline factory-gate --for <X.Y.Z> --from-run <loop-run-id> --json
```

Optional observations / scenarios: see the main FRG runbook.

- [ ] Exit 0 and **pass** / release-eligible  
- [ ] File exists: `.agent-pipeline/frg/<X.Y.Z>/latest.json`  
- [ ] `pass: true` and non-empty `run_id` in that JSON  

```bash
python3 -c "import json; d=json.load(open('.agent-pipeline/frg/<X.Y.Z>/latest.json')); print(d.get('pass'), d.get('run_id'), d.get('version'))"
```

## 4. Land FRG evidence in git

`pipeline release` and auto-tag expect FRG files **in the tree** that gets released.

- [ ] Commit `.agent-pipeline/frg/<X.Y.Z>/` (and required run evidence) on a PR to the integration branch  
- [ ] Merge that PR before or as part of the release flow  

## 5. Finish the ship (after FRG is on disk)

```bash
# Option A — full ship resume (train no-ops when milestone empty / already complete):
export ALLOW_MERGE=1 REPO_DIR PIPELINE
examples/supervisor/shell/ship-milestone.sh --milestone v<X.Y.Z> --detach

# Option B — manual:
pipeline release <X.Y.Z> --no-edit
pipeline release finish <release-pr> --json
# wait for GitHub Release v<X.Y.Z>
pipeline engine-promote --for <X.Y.Z> --host codex --json
```

- [ ] Release PR opened and finished  
- [ ] `gh release view v<X.Y.Z>` published (not draft)  
- [ ] `pipeline --version` matches after promote (or pin policy as designed)  

## 6. If factory-gate refuses the run

| Error | Fix |
|--------|-----|
| non-pack / work-list selector | Use factory-gate **label/milestone** pack, not product train run |
| missing observations / scenarios | Add `--observations` / `--scenario` per runbook |
| pass: false | Fix pack failures; re-run pack; re-score |

## Pointers

- Runbook: `docs/factory-reliability-gate-runbook.md`
- Ship state (host): `$PIPELINE_SUPERVISOR_STATE/ship-v<X.Y.Z>/`
- Do **not** invent FRG pass files to unblock release
