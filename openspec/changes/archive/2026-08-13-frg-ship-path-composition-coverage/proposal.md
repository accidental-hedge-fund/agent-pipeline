## Why

Without composition tests, v1.38.1 can land as green unit islands and still fail the next Tugboat ship the same way: train as N×`single` STOP-on-first-blocked, scratch-only porcelain escalated as `needs-human`, and a blocked peer aborting merge of an already ready-to-deploy independent sibling. Product contracts for scratch recover (#1020), frontier train∘loop (#1023), and stale-block re-review (#1025) already exist; this change locks **cross-component composition proof** so those contracts cannot regress silently under CI.

## What Changes

- Add a hermetic **ship-path composition** regression suite (injected unit and/or FRG Layer A composition output) that exercises train∘loop∘scratch-recover∘independent-merge as composed behavior, not only per-module unit islands.
- Require at least one automated test (or FRG composition output) that **fails** if train advance returns to production N×`single` STOP-on-first-blocked for a multi-item frontier.
- Require at least one automated test that **fails** if scratch-only porcelain parks as `needs-human` or invokes `repair_pipeline_item` on the victim PR for that path.
- Require composition coverage that a blocked/parked item does **not** prevent merge of a proven-independent already-R2D sibling when independence is proven.
- Soft-join (optional but preferred) with #1025: stale `blocked` + newer non-pipeline-internal HEAD → resume re-review before train treats the leftover label as terminal STOP.
- Inventory or co-locate the suite so silent gaps are not permitted (explicit waiver naming a tracking issue only if a class remains uncovered).
- No live network ship in CI; no continuous `ship_model` (#1024); no weakening of security denylist or true human-authority classes.

## Acceptance criteria

- [ ] At least one automated test or FRG composition output fails if train returns to N×`single` STOP-on-first-blocked for a multi-item base-eligible frontier (one multi-item loop/advance-wave call per frontier is the required shape).
- [ ] At least one automated test fails if scratch-only engine porcelain parks as `pipeline:needs-human` / `needs-human` block or invokes `repair_pipeline_item` for that scratch-only path.
- [ ] At least one automated test fails if a blocked/parked item aborts merge of a proven-independent already-R2D sibling when independence is proven from deps/ledger.
- [ ] Code-dependent A→B composition: a hermetic test fails if B enters an advance wave while A’s merge-result is not contained in the fetched base.
- [ ] Soft (preferred): at least one test fails if stale `blocked` with newer non-internal HEAD terminal-STOPs train before one stale-block resume / re-review attempt.
- [ ] Composition tests inject deps (no real network, git, or subprocess in unit Layer A); full live network ship remains out of scope for this issue.
- [ ] After any `core/` edits, `plugin/` is regenerated; `openspec validate` for this change and `npm run ci` pass.

## Capabilities

### New Capabilities

- `ship-path-composition-coverage`: Hermetic (and optional FRG Layer A composition) regression contract for v1.38.1 ship-path autonomy composition — frontier loop advance, scratch-only recover, independent-sibling merge under partial failure, and soft stale-block re-review before train STOP.

### Modified Capabilities

- `factory-reliability-gate`: Extend Layer A / composition ownership so the ship-path composition classes cannot be silent gaps (test present, or explicit open-issue waiver); do not expand Layer B live pack ids unless implementation chooses FRG evidence mapping without requiring live network ship in CI.
- `integrated-train-mode`: Pin that composition/regression tests are mandatory for frontier advance-wave shape, code-dep merge barrier, and independent R2D sibling merge under partial failure (behavior already specified; this change adds falsifiable composition proof requirements).
- `engine-scratch-recover`: Pin that composition/regression tests fail if scratch-only dirt parks as `needs-human` or runs `repair_pipeline_item` on the victim path (behavior already specified; this change adds composition proof).
- `stale-blocked-rereview`: Soft-join — composition suite MAY include stale-block resume before train STOP; when included, the test fails if resume is skipped (does not block the three hard acceptance items above).

## Impact

- Tests primarily: `core/test/train.test.ts`, dirt/recovery tests (`worktree-dirt`, pipeline-recovery / loop recovery), optional dedicated `core/test/*ship-path-composition*` or FRG Layer A extensions under `factory-reliability-gate-layer-a.test.ts`.
- Optional small inventory/helpers under `core/scripts/` if Layer A ownership or composition-class inventory needs a stable id list (mirror FRG Layer A waiver pattern).
- Product production paths for train, scratch recover, and stale-block are **not** re-specified here beyond composition proof; depends on landed or concurrent #1020 / #1023 (and soft #1025).
- Parent epic: #1028. Complementary to #1035 (Layer B pack restore after v1.38.1) — this issue is composition/FRG *tests*, not the live pack driver or Tugboat hard gate.
- Non-goals: full live network ship in CI; continuous `ship_model` (#1024); weakening security denylist or human-authority classes; N×`single` production train; `auto_merge` / merge-from-advance.
- `plugin/` mirror only if implementation touches `core/`; intent-only step does not change application code.
