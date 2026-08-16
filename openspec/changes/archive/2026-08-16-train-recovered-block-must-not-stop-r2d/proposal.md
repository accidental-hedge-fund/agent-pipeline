## Why

Serial `--merge` train for v1.39.2 STOPped on #1037 with `implementation-ci` after the item had already reached `pipeline:ready-to-deploy`. The loop recovered the mid-run test-gate failure, a later advance finished `ready_to_deploy`, and the run ended `all_done` — but train still treated a leftover `loop_item_blocked` as the current wave failure (#1095). That is a class defect in train advance-outcome classification: a recovered block is not a live STOP.

## What Changes

- Train advance-wave evidence SHALL treat the last **terminal** event for an item as current. A later `ready_to_deploy` / `all_done` (or equivalent successful terminal) SHALL supersede an earlier `loop_item_blocked` for that same item.
- `classifyTrainAdvanceLabels` SHALL classify **ok** with terminal `ready-to-deploy` when live labels are `pipeline:ready-to-deploy`, the wave ended in a successful terminal, there is no current `loop_run_stopped`, and there is no live `blocked` label.
- Merge-mode train SHALL merge that ready-to-deploy item instead of STOP.
- #1074 still holds: live `pipeline:ready-to-deploy` SHALL NOT mask a wave that actually stopped (`loop_run_stopped`) or left a non-zero engine failure.
- When a ledger item transitions to `ready`, current `blocked_theme` SHALL be cleared (or ignored for any consumer that reads theme while `state === "ready"`) so the ledger matches live state.

## Acceptance Criteria

- [ ] Fixture: loop events include `loop_item_blocked` (`implementation-ci`) then a later `ready_to_deploy` / `all_done` for the same item; live labels are `pipeline:ready-to-deploy` and not `blocked`. `classifyTrainAdvanceLabels` returns `ok: true` with terminal `ready-to-deploy`.
- [ ] Fixture: live `pipeline:ready-to-deploy` labels plus a current `loop_run_stopped` (or a non-zero engine failure / engine message) still yield `ok: false` (#1074).
- [ ] Merge-mode train fixture: after the recovered-block-then-R2D wave, train invokes the existing merge surface for that item and does not STOP with `advance failed for #<N>: implementation-ci`.
- [ ] Evidence extractor: a later successful terminal for the same item does not leave `blockedClass` as current evidence for that item.
- [ ] Ledger: an item that transitions to `ready` does not keep a current `blocked_theme` that a later consumer could treat as a live block.
- [ ] Unit tests inject deps (no real network, git, or subprocess). If `core/` changes, regenerate `plugin/`. `npm run ci` green.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `integrated-train-mode`: Recovered mid-run `loop_item_blocked` SHALL NOT make a later ready-to-deploy wave classify as failed. Last successful terminal for the item wins. Merge-mode train SHALL merge that item. #1074 stop/engine-failure masking remains forbidden.
- `durable-loop-store`: A ledger item that transitions to `ready` SHALL NOT retain a current `blocked_theme`. History may still record the prior block.

## Impact

- **Primary (intent for implement):** shared train advance evidence + classification — `extractTrainAdvanceLoopEvidence` / `classifyTrainAdvanceLabels` / `advanceWaveThroughLoop` in `core/scripts/stages/train-advance-stop-reason.ts` and `core/scripts/pipeline.ts`; merge-mode path in `core/scripts/stages/train.ts`. Tests in `core/test/train-advance-stop-reason.test.ts`, `core/test/pipeline-cli.test.ts`, and train fixtures.
- **Ledger hygiene:** `transitionItem` (or the ready-transition writer) in `core/scripts/loop/reconcile.ts` clears current `blocked_theme` when `to === "ready"`. Tests in loop store/reconcile fixtures.
- **Out of scope:** merging PR #1094 (operator / resume ship); weakening a real current test-gate failure; changing FRG / `--skip-frg`; merge inside advance/loop; N×`single` as production path; reversing papercut backlog policy (#538).
- **Program:** v1.39.2. Independent of #1036–#1041 / #1092. Observed on the #1037 ship; does not wait on #1037 merge.
- **Class vs site (engine-dogfood bar):** this is a **class** fix. The next recovered `implementation-ci` (or any recoverable class) followed by `ready_to_deploy` / `all_done` + live R2D must classify ok and merge without a new mole issue.
