## Why

When pre-merge leaves genuine blocking review findings, the durable loop is supposed to recover via `repair_pipeline_item` without a human. In dogfood **#599** (v1.39.0 ship, PR #1058) that channel burned its full budget three times with **no commit** while engine-owned `artifacts/challenge-response-*.json` sat in the worktree, then parked the item on a generic "did not produce a committed and pushed repair" string. The findings were real; the repair channel was not debuggable and did not clear engine scratch first. `#1020` added `unlink_engine_scratch` only for `workflow-engine-defect`; the generic `review-findings` class still skips that prep.

## What Changes

- Default recovery policy for durable class `review-findings` lists `unlink_engine_scratch` **before** `repair_pipeline_item` (class-level extension of the #1020 unlink recipe).
- For `review-findings`, unlink is **preparatory**: remove engine-known scratch so the repair hook sees a clean product tree. Unlink alone does **not** count as substantive review repair and does **not** clear a findings block as if findings were fixed.
- When unlink is not applicable (no current engine-scratch paths), the controller advances to `repair_pipeline_item` without treating the item as recovered and without stranding recovery on a permanent unlink no-op.
- `repair_pipeline_item` failure evidence distinguishes at least: (a) implementer-reported clean no-change (`noop-clean`), (b) scratch/dirt-blocked commit path, (c) harness/error path with no commit — each carrying status and a harness/output diagnostic tail when available. The generic collapsed string is not the sole signal for non-`fix-committed` outcomes.
- Persisted stale default policy for `review-findings` (repair-only recipes) migrates to the new default the same way other class defaults already migrate.
- Regression fixtures resemble the #599 shape: challenge-response scratch present under `review-findings` → unlink before repair on a clean tree; repair exits without commit → operator-visible typed failure evidence.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `autonomous-recovery-controller`: Change default `review-findings` recipe sequence to include preparatory `unlink_engine_scratch` before `repair_pipeline_item`; require substantive repair still to move the candidate; require `repair_pipeline_item` failure evidence to distinguish no-commit / dirt-blocked / implementer no-change statuses with diagnostic tails.
- `engine-scratch-recover`: Extend the ordered-unlink contract beyond `workflow-engine-defect` so the shared `unlink_engine_scratch` action is the first deterministic prep for `review-findings` recovery when engine-known scratch is present, without reclassifying product findings as scratch-only success.

## Acceptance criteria

- [ ] Default recovery policy for durable class `review-findings` lists `unlink_engine_scratch` before `repair_pipeline_item` under test.
- [ ] Fixture shaped like #599: `review-findings` with engine-known `artifacts/challenge-response-*.json` present → recovery claims `unlink_engine_scratch` before `repair_pipeline_item`, and the repair attempt observes a worktree free of that engine scratch.
- [ ] Unlink alone does not mark `review-findings` recovery successful when blocking findings still apply at the same candidate (no false “findings fixed by scratch unlink”).
- [ ] When no engine-scratch paths are present, recovery still reaches `repair_pipeline_item` for the findings class (does not stop as recovered or dead-end on unlink).
- [ ] Fixture: repair hook completes without a committed+pushed repair → returned error/evidence includes the non-success status and a harness/output diagnostic tail (or explicit implementer no-change diagnostic), not only the collapsed generic “did not produce a committed and pushed repair” string for every status.
- [ ] Stale persisted default `review-findings` policy that lists only `repair_pipeline_item` migrates to the new default recipes on contract upgrade.
- [ ] Unit tests inject deps (no real network, git, or subprocess); after any `core/` edits, `plugin/` is regenerated; `openspec validate` for this change and `npm run ci` pass.

## Impact

- `core/scripts/loop/recovery.ts` — `DEFAULT_RECOVERY_POLICY["review-findings"]` recipes; `STALE_DEFAULT_POLICY_ENTRIES` for pre-#1060 repair-only default.
- `core/scripts/pipeline.ts` — `unlink_engine_scratch` behavior when claimed under `review-findings` (prep vs terminal scratch-only clear).
- `core/scripts/loop/repair-pipeline-item.ts` — non-`fix-committed` error construction; optional pre-repair engine-scratch strip if design chooses dual-prep defense.
- `core/scripts/stages/pre-merge-autofix.ts` (or shared harness-round) — ensure error/`noop-clean` diagnostics propagate with enough tail for the recovery shell.
- Tests: `loop-recovery.test.ts`, `pipeline-recovery-executor.test.ts`, `loop-supervisor.test.ts`, repair-pipeline-item regressions; ship-path composition coverage if it asserts `review-findings` recipe order.
- Living specs: `autonomous-recovery-controller`, `engine-scratch-recover` (deltas in this change).
- No merge/auto-merge, no human-authority reclassification, no broad `artifacts/**` waiver, no weakening of review gates.
