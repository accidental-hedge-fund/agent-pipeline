## Why

Engine-owned scratch (today: `artifacts/challenge-response-*.json`) still escalates as `needs-human` at dirt gates that do not share `classifyWorktreeDirt`. Loop recovery then runs `repair_pipeline_item` against the blocked PR, and `train` STOPs on the leftover `blocked` label. Live dogfood: **#1013** / PR **#1016** during v1.38.0 ship — review-2 approved, pre-merge archive blocked three times on `?? artifacts/challenge-response-1013.json` (`blocker_kind: needs-human`). Sibling **#1017** fixed the pre-merge archive site only. Epic **#1028** landed a first cut of `engine-scratch-recover` and `unlink_engine_scratch`; this change locks the **full #1020 contract**: every porcelain dirt gate classifies scratch the same way, scratch-only never parks as human, residual engine blocks use `harness-failure` → `workflow-engine-defect`, recovery unlinks before implementer repair, and a drift guard stops the next path-shaped mole.

## What Changes

- Every dirt gate that can `setBlocked` on worktree porcelain MUST use the shared classifier (`classifyWorktreeDirt` / `ENGINE_NON_PRODUCT_SCRATCH_GLOBS`) — pre-merge archive (after #1017), test-gate, format-gate, salvage, and any sibling porcelain check.
- Scratch-only porcelain: best-effort unlink (same spirit as `.pipeline-rebase-attempted` marker-only dirt) and **do not** `setBlocked`.
- If a block must still be emitted for an engine-scratch / factory-defect residual, kind is `harness-failure` (projects `workflow-engine-defect`) — never `needs-human`, never `human-decision-required`.
- Deterministic recovery recipe `unlink_engine_scratch` remains (or is completed) in the default loop recovery policy for `workflow-engine-defect` **before** `repair_pipeline_item`: unlink known scratch → `clearBlocked` → resume current stage. No harness round. No commit on the candidate.
- Product / dirty `openspec/` / dirty `core/` porcelain still hard-blocks.
- Drift guard: new porcelain / `setBlocked` dirt sites cannot bypass `classifyWorktreeDirt` without an inventory or disposition update.
- No broad `artifacts/**` waiver; no LLM human-vs-engine classification; no patching engine source into the blocked item's PR.

## Capabilities

### New Capabilities

- (none) — strengthens the existing `engine-scratch-recover` capability and related dirt / recovery surfaces.

### Modified Capabilities

- `engine-scratch-recover`: Strengthen gate-time shared classification and unlink-without-block; residual block kind must be `harness-failure` / `workflow-engine-defect` not `needs-human`; keep `unlink_engine_scratch` ordered ahead of `repair_pipeline_item`; add a drift-guard requirement so new porcelain dirt sites cannot bypass the shared classifier without inventory update.
- `autonomous-recovery-controller`: Ensure the default recovery policy for the engine-scratch / `workflow-engine-defect` path lists `unlink_engine_scratch` before implementer repair and does not treat mechanical scratch recover as a human hold.
- `test-gate-non-product-dirty`: Align any remaining gate wording so scratch-only porcelain never mintes `needs-human` / blocked solely for engine-known scratch (product dirt remains fail-closed).

## Acceptance criteria

- [ ] Porcelain that lists only `?? artifacts/challenge-response-<N>.json` (or equivalent engine-known scratch) does **not** set `pipeline:blocked` or escalate as `needs-human` at any dirt gate that can block on porcelain.
- [ ] Dirty product paths under `core/` or dirty product `openspec/` still hard-block with path disclosure.
- [ ] When a residual engine-scratch path still must emit a block (e.g. classification failure after unlink budget, or non-scratch residual mis-framed as scratch), the block kind is `harness-failure` (projects `workflow-engine-defect`), not `needs-human` or `human-decision-required`.
- [ ] Unit test: scratch-only recovery executes `unlink_engine_scratch` → unlink + `clearBlocked` and does **not** invoke `repair_pipeline_item` for that attempt.
- [ ] Unit test: default recovery recipe order for `workflow-engine-defect` places `unlink_engine_scratch` ahead of `repair_pipeline_item`.
- [ ] Drift-guard unit test fails when a new production porcelain dirt / `setBlocked` site bypasses `classifyWorktreeDirt` without an inventory or disposition update.
- [ ] Challenge-response / engine scratch is never auto-committed into the product tree as part of recover.
- [ ] After any `core/` edits, `plugin/` is regenerated; `openspec validate` for this change and `npm run ci` pass.

## Impact

- `core/scripts/worktree-dirt.ts` — shared classifier / `ENGINE_NON_PRODUCT_SCRATCH_GLOBS` (source of truth).
- Dirt gates: `testgate.ts`, `stages/format-gate.ts`, `stages/pre-merge-openspec-archive.ts`, `salvage-harness-work.ts`, any sibling porcelain `setBlocked` sites.
- Recovery: `loop/recovery.ts` default policy, `pipeline.ts` (or recovery executor) `unlink_engine_scratch` action.
- Diagnostics: `stage-diagnostic.ts` projection for residual scratch blocks → `workflow-engine-defect`.
- Drift guard: inventory under `core/scripts/` (or co-located test) for porcelain dirt sites, analogous to `escalation-site-dispositions`.
- Tests: `pipeline-recovery-executor.test.ts`, `loop-supervisor` / recovery policy order tests, dirt-gate regressions, new drift-guard test.
- Generated `plugin/` mirror when `core/` changes.
- Depends on: **#1017** (done). Part of ship-path autonomy epic **#1028**. Enables **#1021**; soft-enables **#1023**. Composition/FRG: **#1029**.
