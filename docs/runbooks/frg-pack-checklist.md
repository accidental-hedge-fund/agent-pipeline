# FRG pack checklist (operator)

**Goal:** diagnose or manually produce `.agent-pipeline/frg/<X.Y.Z>/latest.json`
when Pipeline ship status identifies FRG evidence as the blocking input.

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

## 4. Keep FRG evidence for release prepare

`pipeline release` and `pipeline release ensure-tag` read on-disk HMAC
`.agent-pipeline/frg/<X.Y.Z>/latest.json` on the ship host. That directory is
gitignored. Auto-tag must not stall the ship for a missing tree file.

- [ ] Leave the validated version directory in the control checkout
- [ ] Do not merge a separate evidence PR into the base after the candidate is
      recorded; that would move the candidate before release prepare

## 5. Resume the Pipeline-owned ship (after FRG is on disk)

```bash
export ALLOW_MERGE=1 REPO_DIR PIPELINE
examples/supervisor/shell/ship-milestone.sh \
  --milestone v<X.Y.Z> \
  --for <X.Y.Z> \
  --authorization /absolute/path/to/current-authorization.json \
  --detach
```

- [ ] `pipeline ship status --milestone v<X.Y.Z> --for <X.Y.Z> --json` reports
      the expected resumed checkpoint
- [ ] Final typed status reports completion and the promoted engine identity

## 6. If factory-gate refuses the run

| Error | Fix |
|--------|-----|
| non-pack / work-list selector | Use factory-gate **label/milestone** pack, not product train run |
| missing observations / scenarios | Add `--observations` / `--scenario` per runbook |
| pass: false | Fix pack failures; re-run pack; re-score |

## Pointers

- Runbook: `docs/factory-reliability-gate-runbook.md`
- Ship state: use `pipeline ship status`; do not infer it from host files
- Do **not** invent FRG pass files to unblock release
