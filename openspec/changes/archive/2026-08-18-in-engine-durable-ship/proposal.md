## Why

Tugboat / Hermes / Buzz is a second untracked composer. A week of host glue did not produce a ship that recovers or honors merge-first. Live 2026-08-16 v1.39.2: #1037 reached `pipeline:ready-to-deploy` (PR #1094 MERGEABLE, checks green); train STOPped on leftover `implementation-ci` (#1095); the operator re-said `Ship milestone v1.39.2`; train logged `merge-first #1037` then implemented #1095 while #1094 stayed open. A later mid-implement SIGTERM of #1095 reused the dead loop, classified harness-failure as `workflow-engine-defect`, burned `restart_workflow_engine` to zero, then six `coexistence_wait`s on the corpse to `supervisor_no_progress`. Hosts cannot own terminal classification or merge order.

## What Changes

- **BREAKING (operator surface):** `pipeline ship --milestone vX.Y.Z` is the product command. It chains existing verbs: `train --merge` → (semver) `release` → wait checks → `release finish` → wait GitHub Release → `engine-promote`. It does not invent a second merge policy, grant schema, or scheduler.
- **BREAKING (grant path):** The existing `pipeline ship --authorization` / signed-grant surface is **not** this feature and MUST NOT be revived as the operator invocation. Operator invocation of `pipeline ship --milestone` is the same authority class as `pipeline train --merge`.
- One durable ship ledger under the target repo (or factory control checkout). Restart of the same milestone/version continues that ledger. A second invoke MUST NOT implement a newer sibling while an earlier ready-to-deploy PR is still open.
- Kill / crash / power loss is resume. A dead harness, SIGTERM, host reboot, or network drop mid-stage is **not** `workflow-engine-defect` and MUST NOT burn the class budget to `supervisor_no_progress`. Re-invoke continues the same item from its last durable stage (worktree + labels + ledger). `coexistence_wait` on a **dead** prior holder is takeover, not STOP.
- Merge-first is an invariant of `train --merge` (the only merge policy ship uses): every `pipeline:ready-to-deploy` item with an open mergeable PR is merged and **base-contained** before any other milestone item is planned or implemented. Violation fails the ship.
- Engine recover for non-human classes: leftover `blocked_theme` / recovered `loop_item_blocked` on a live ready-to-deploy item (#1095), pin/checkout drift (`install:engine-track` vs `origin`), stale `loop_item_blocked` after `all_done`. Hosts do not diagnose these.
- Hosts (Hermes, OpenClaw, Claude, Codex, Grok, omp, OpenCode): install CLI + short SKILL. Phrase `Ship milestone vX.Y.Z` execs `pipeline ship --milestone vX.Y.Z` (detach if the CLI is not already non-blocking). Status/stop read the Pipeline ship ledger. Notify on phase/item transitions and terminal failure. No Tugboat state machine.
- Hermes does not recover. On notify of a non-human failure it re-invokes the same `pipeline ship --milestone …`. If the ledger says human authority, it stops and says so.
- Doctrine for #1001 / #971 / Tugboat MUST NOT be readable as “never in-engine ship.” Tugboat may keep notify/detach as a thin adapter. Do not pack Tugboat as the 1.40.1 product.

## Acceptance criteria

- [ ] `pipeline ship --milestone vX.Y.Z` (or a documented alias of that exact argv) resumes from the ship ledger; a second invoke of the same milestone does not plan or implement a newer sibling while an earlier `pipeline:ready-to-deploy` PR is still open.
- [ ] Merge-first fixture: work list has ready-to-deploy #A with an open MERGEABLE PR and ready #B; the first mutation is merge of #A (proves closed #1063). A later implement of #B while #A is still open fails the fixture.
- [ ] #1095 class: leftover `loop_item_blocked` (or leftover `blocked_theme`) plus live `pipeline:ready-to-deploy` without live `blocked` → ship / `train --merge` merges that item and does not STOP-then-farm a sibling.
- [ ] Kill mid-implement (or equivalent dead holder) plus re-`pipeline ship` of the same milestone resumes #N from its last durable stage. It does not STOP `supervisor_no_progress` and does not leave a leftover `workflow-engine-defect` that burned `restart_workflow_engine`.
- [ ] `coexistence_wait` whose recorded holder is dead is takeover of that same item, not a STOP and not a wait-until-watchdog cycle.
- [ ] Skill and operator docs: `Ship milestone vX.Y.Z` → `pipeline ship --milestone vX.Y.Z`; notify on phase/item/fail; status/stop read the Pipeline ship ledger; no Tugboat owner.
- [ ] Hermes/host on a non-human failure: re-invoke the same `pipeline ship --milestone …` only. No classify, no run-dir janitor, no invented `single`/`loop`. Human-authority ledger state stops the host and says so.
- [ ] #1001 / #971 / Tugboat doctrine cannot be read as “never in-engine ship.” Packs stay phrase → `pipeline …`.
- [ ] Existing grant/authorization JSON path is not the operator surface and is not required for `pipeline ship --milestone vX.Y.Z`.
- [ ] Advance / single / loop still never merge. Ship composes `train --merge` / existing merge gates only.
- [ ] Unit tests inject deps (no real network, git, or subprocess). If `core/` changes, regenerate `plugin/`. `npm run ci` green.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `ship-coordinator`: Operator product is `pipeline ship --milestone vX.Y.Z` without a grant document. One durable ledger. Resume-safe across kill/crash. Compose existing verbs only. Hosts are phrase → CLI.
- `tugboat-thin-ship`: Tugboat is not the product owner. Phrase `Ship milestone vX.Y.Z` maps to `pipeline ship --milestone vX.Y.Z`. Doctrine cannot be read as “never in-engine ship.”
- `integrated-train-mode`: Merge-first is an invariant of `train --merge`: ready-to-deploy + open mergeable PR is merged and base-contained before any other work-list item is planned or implemented.
- `merge-authority-boundary`: Operator-invoked `pipeline ship --milestone` is a loop-isolated merge/ship surface. No grant factory. Advance still never merges.
- `scoped-autonomous-factory-operations`: Ship authority is operator CLI invocation of the milestone ship command, not a signed grant JSON. Grant path is not revived as the operator surface.
- `loop-live-advance-coexistence`: A dead prior holder is takeover of the same item, not `coexistence_wait` STOP.
- `durable-blocker-classification`: Kill / crash / power-loss / network drop mid-stage with a dead holder is resume-eligible interrupt, not `workflow-engine-defect`.
- `autonomous-recovery-controller`: First recover for a dead-holder interrupt is resume of the same item. It MUST NOT claim `restart_workflow_engine` as the first recipe or burn that class budget to `supervisor_no_progress`.
- `durable-loop-supervisor`: Re-invoke of the same ship/milestone MUST NOT reuse a dead loop into `supervisor_no_progress`. Dead-holder wait is not a no-progress cycle.
- `host-neutral-progress-notify`: Hosts notify from the Pipeline ship ledger and exact child-run identities. Phrase `Ship milestone vX.Y.Z` execs the CLI. Hermes re-invokes the same command on non-human failure.

## Impact

- **Primary:** `core/scripts/stages/ship-adapter.ts`, ship CLI parsing in `core/scripts/pipeline.ts`, ship ledger/status, `core/scripts/stages/train.ts` merge-first prelude, shared train classification already landed by #1095.
- **Recover class:** durable blocker projection, live-advance / coexistence probe, loop supervisor reuse of a dead run, recovery recipe order for interrupt vs `workflow-engine-defect`.
- **Hosts / doctrine:** `hosts/*/SKILL.md`, Hermes / supervisor examples, `docs/runbooks/ship-milestone.md`, `docs/supervisor.md`, Tugboat thinness tests so they no longer treat `pipeline ship ` as a forbidden product path.
- **Out of scope:** grant factory / MessagingPort / ship-auth issuer (#966–#968); packing Tugboat as the 1.40.1 product (#971 as written); continuous `ship.model` (#1024); finishing or remiling the v1.39.2 FRG train; auto-merge from `pipeline N` / loop advance; #1114 / #1115 (independent v1.39.3 patches; this epic does not wait on them).
- **Program:** v1.39.3, after the v1.39.2 FRG pack, before v1.40.1 supervisor packs. Compatible with v1.40.0 CLI-as-product. Depends on #1095 (classify leftover block). Do not train this on the v1.39.2 milestone.
