## Why

When pre-merge leaves genuine blocking review findings, the durable loop is supposed to recover via `repair_pipeline_item` without a human. In dogfood **#599** (v1.39.0 ship, PR #1058) that channel burned its full budget three times with **no commit** while engine-owned `artifacts/challenge-response-*.json` sat in the worktree, then parked the item on a generic "did not produce a committed and pushed repair" string. The findings were real; the repair channel was not debuggable and did not clear engine scratch first. `#1020` added `unlink_engine_scratch` only for `workflow-engine-defect`; the generic `review-findings` class still skips that prep.

## What Changes

- Default recovery policy for durable class `review-findings` lists `unlink_engine_scratch` **before** `repair_pipeline_item` (class-level extension of the #1020 unlink recipe).
- For `review-findings`, unlink is **preparatory**: remove engine-known scratch so the repair hook sees a clean product tree. Unlink alone does **not** count as substantive review repair and does **not** clear a findings block as if findings were fixed.
- Prep unlink (scratch removed or no-scratch not-applicable) advances to `repair_pipeline_item` in the **same recovery sequence**, without consuming findings `retry_budget` or repeated-evidence budget.
- **Single** authoritative scratch-cleanup boundary: only `unlink_engine_scratch` strips engine-known scratch; `repair_pipeline_item` does not dual-prep strip.
- `repair_pipeline_item` failure evidence is a typed, bounded contract (`status`, category `noop-clean` | `dirt-blocked` | `harness-error` | `no-diagnostic`, diagnostic tail or explicit absence) that survives into supervisor events — not only the collapsed generic string.
- Dirt-blocked classification uses the shared porcelain classifier; product dirt remains fail-closed; no broad `artifacts/**` waiver.
- Persisted **exact** stale default policy for `review-findings` (repair-only recipes) migrates to the new default; user-custom policies are preserved.
- Regression fixtures resemble the #599 shape.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `autonomous-recovery-controller`: Change default `review-findings` recipe sequence to include preparatory `unlink_engine_scratch` before `repair_pipeline_item`; same-sequence free prep; require substantive repair still to move the candidate; require typed `repair_pipeline_item` failure evidence that survives to recovery events.
- `engine-scratch-recover`: Extend the ordered-unlink contract beyond `workflow-engine-defect` so the shared `unlink_engine_scratch` action is the first deterministic prep for `review-findings` recovery when engine-known scratch is present, without reclassifying product findings as scratch-only success; single cleanup boundary.

## Acceptance criteria

- [ ] Default recovery policy for durable class `review-findings` lists `unlink_engine_scratch` before `repair_pipeline_item` under test.
- [ ] Fixture shaped like #599: `review-findings` with engine-known `artifacts/challenge-response-*.json` present → recovery claims `unlink_engine_scratch` before `repair_pipeline_item`, and the repair attempt observes a worktree free of that engine scratch.
- [ ] Unlink alone does not mark `review-findings` recovery successful when blocking findings still apply at the same candidate (no false “findings fixed by scratch unlink”).
- [ ] Prep unlink does not decrement findings retry budget; three implementer repair attempts remain available after free prep.
- [ ] When no engine-scratch paths are present, recovery still reaches `repair_pipeline_item` for the findings class in the same sequence (does not stop as recovered or dead-end on unlink).
- [ ] Fixture: repair hook completes without a committed+pushed repair → returned error/evidence includes status, category, and harness/output diagnostic tail (or explicit implementer no-change / no-diagnostic), not only the collapsed generic string; same content appears on the recovery execution event path.
- [ ] Exact stale persisted default `review-findings` policy migrates; custom non-default policies are preserved under test.
- [ ] `workflow-engine-defect` terminal scratch-only recover remains unchanged under test.
- [ ] Unit tests inject deps (no real network, git, or subprocess); after any `core/` edits, `plugin/` is regenerated; `openspec validate` for this change and `npm run ci` pass.

## Impact

- `core/scripts/loop/recovery.ts` — `DEFAULT_RECOVERY_POLICY["review-findings"]` recipes; `STALE_DEFAULT_POLICY_ENTRIES` for pre-#1060 exact repair-only default; budget-exempt prep start if implemented at start seam.
- `core/scripts/loop/supervisor.ts` — same-sequence continuation after findings prep unlink; skip unlink claim when no scratch when required by D3.
- `core/scripts/pipeline.ts` — `unlink_engine_scratch` behavior when claimed under `review-findings` (prep fall-through vs terminal scratch-only clear).
- `core/scripts/loop/repair-pipeline-item.ts` — typed non-`fix-committed` error construction; **no** dual-prep engine-scratch strip.
- `core/scripts/stages/pre-merge-autofix.ts` (or shared harness-round) — ensure pre-dirty / error / `noop-clean` diagnostics propagate with enough tail for the recovery shell.
- Tests: `loop-recovery.test.ts`, `pipeline-recovery-executor.test.ts`, `loop-supervisor.test.ts`, repair-pipeline-item regressions; ship-path composition coverage if it asserts `review-findings` recipe order.
- Living specs: `autonomous-recovery-controller`, `engine-scratch-recover` (deltas in this change).
- No merge/auto-merge, no human-authority reclassification, no broad `artifacts/**` waiver, no weakening of review gates.
