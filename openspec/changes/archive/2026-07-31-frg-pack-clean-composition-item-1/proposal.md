## Why

The Factory Reliability Gate (FRG) Layer B fixed pack for release **1.29.1** must
exercise multi-item composition, including scenario `clean-item-throughput`
(≥ **K** easy items reach `pipeline:ready-to-deploy` without an engine-class
block). This issue is synthetic pack item 1: a deliberately trivial clean
throughput item so the `factory-gate` pack has ready-to-deploy volume without
product feature work or FRG scoring changes.

## What Changes

- Add a **minimal docs or comment-only** provenance note (one line under
  `docs/` or a one-line README note) that identifies this change as FRG pack
  clean composition item 1 for release 1.29.1 / pack `factory-gate-v1`.
- Keep the OpenSpec change valid so pre-merge archive (or equivalent) can
  complete without an OpenSpec structural block.
- Open a PR and advance it to `pipeline:ready-to-deploy` without an
  engine-class block (the observable outcome the pack scores).
- **No** product feature work and **no** changes to release or FRG scoring
  code (`factory-reliability-gate.ts`, scoreboard, thresholds, driver).

## Acceptance criteria

- [ ] An OpenSpec change for this issue exists under
      `openspec/changes/frg-pack-clean-composition-item-1/` (or is archived
      into living specs) and `openspec validate frg-pack-clean-composition-item-1`
      (or `openspec validate --all` when archived) passes.
- [ ] The landed tree contains a minimal docs/comment-only provenance note
      (under `docs/` **or** a single-line README note) that names this work as
      FRG pack clean composition item 1 for release **1.29.1** (and does not
      claim product or scoring behavior changes).
- [ ] The implementation diff does **not** modify FRG scoring, release
      preflight, factory-gate driver logic, or product feature surfaces outside
      that provenance note (and the OpenSpec change artifacts for this issue).
- [ ] A PR for this issue reaches label `pipeline:ready-to-deploy` without an
      engine-class block (clean throughput outcome for pack composition scoring).
- [ ] `npm run ci` passes on the PR head.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `factory-reliability-gate`: ADDED documentation requirement that synthetic
  clean composition pack items used for Layer B `clean-item-throughput` leave
  an in-tree one-line provenance note naming pack role and target release
  version (docs/ or README). No change to FRG scoring thresholds, scenario ids,
  evidence schema, or driver pass/fail logic.

## Impact

- **Docs only (implementation):** one-line note in `README.md` and/or
  `docs/factory-reliability-gate-runbook.md` (or an adjacent `docs/` file).
- **OpenSpec:** this change folder; archive into
  `openspec/specs/factory-reliability-gate/` at pre-merge if still active.
- **Out of scope:** `core/scripts/factory-reliability-gate.ts`, release
  sub-command, FRG thresholds (K/N/engine-class rate), scoreboard metrics,
  product features, auto-merge, review-rigor demotion.
