## Why

The chain-to-existing-tools ship playbook (`examples/supervisor/shell/pipeline-ship-playbook.sh`) false-fails the train completion gate with `train JSON not complete` even when every milestone issue has reached `ready-to-deploy` and merged. The gate used whole-stream `json.load` on the captured `pipeline train --json` stdout, but that stream can contain human-readable prose before the trailing `train_status` JSON object, so parse throws and the playbook exits 1 before release / wait-for-GitHub-Release / engine-promote. This blocked finishing the v1.35.0 ship after a successful train.

## What Changes

- The ship playbook train completion gate SHALL evaluate train completeness from a trailing (or embedded) `train_status` object even when non-JSON prose precedes it on the captured stream.
- Completion SHALL require the selected `train_status` to have `complete: true` and no blocker; when a blocker is present, the playbook SHALL still capture it for operator diagnostics (existing `.blocker` side file behavior preserved).
- The gate SHALL NOT treat a successful mixed stream (prose + final complete `train_status` with null/absent blocker) as failure solely because whole-stream `json.load` cannot parse the file.
- Resume-path parsing of prior `train_status complete=true` remains authoritative for already-complete trains; this change aligns the post-train success gate with that same streaming decode approach.
- Regression coverage SHALL prove the mixed-stream complete case passes and incomplete/blocker cases still fail.

### Acceptance criteria

- [ ] Given a `train.json` capture that contains human-readable prose followed by a single `train_status` object with `complete: true` and no blocker, the ship playbook train completion gate evaluates success (does not exit 1 with `train JSON not complete`) and continues to later ship phases.
- [ ] Given the same mixed stream where the last `train_status` has `complete: false` or a non-null `blocker`, the gate fails closed and surfaces the blocker (or incomplete) detail rather than proceeding to release.
- [ ] Given a pure JSON file that is only a complete `train_status` (no leading prose), the gate still evaluates success (no regression of the pure-JSON path).
- [ ] When the last decoded `train_status` carries a blocker, the gate writes that blocker string to the existing `train.json.blocker` side file (or equivalent path the playbook already uses for detail).
- [ ] A regression check (unit/script-level exercise of the decode+evaluate logic, or fixture-driven playbook gate) fails if the gate reverts to whole-stream `json.load` only, and passes when trailing/`raw_decode` evaluation of the last `train_status` is used.
- [ ] Scope stays on the supervisor ship playbook train gate: no change to merge authority, no new ship/merge stage on advance/loop, and no requirement that `pipeline train --json` stop emitting pure JSON when the engine already does so.

## Capabilities

### New Capabilities

- `supervisor-ship-playbook`: Chain-to-existing-tools ship playbook (`pipeline-ship-playbook`) train completion evaluation contract — how captured `pipeline train --json` output is decoded and judged complete vs blocked before later ship phases run.

### Modified Capabilities

- _(none)_ — living `integrated-train-mode` already requires a final `train_status` JSON document for `--json`; this change hardens the outer playbook consumer without rewriting the train emit contract.

## Impact

- **Primary surface:** `examples/supervisor/shell/pipeline-ship-playbook.sh` train completion gate (and any co-located helper extracted for testability). Not under `core/`; no `plugin/` mirror regen required unless implementation unexpectedly moves logic into `core/`.
- **Operators / ships:** Unblocks ship playbook runs that complete train successfully but currently false-fail at the parse gate (observed on v1.35.0), so release, publication wait, and engine-promote can run.
- **Related living contracts:** `integrated-train-mode` (train `--json` final object); `ship-coordinator` remains the in-engine `pipeline ship` path and is out of scope unless intentionally aligned later.
- **Tests:** Fixture or extracted pure-function coverage for mixed-stream complete, pure-JSON complete, incomplete, and blocker cases.
- **Out of scope:** Changing train merge semantics; auto-merge; rewriting `pipeline train` stdout contract; Hermès/Buzz factory control plane; altering FRG / release / engine-promote phase logic beyond unblocking them after a true-complete train.
