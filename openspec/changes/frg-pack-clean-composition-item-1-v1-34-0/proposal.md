## Why

The Factory Reliability Gate (FRG) Layer B fixed pack for release **1.34.0** must
exercise multi-item composition, including scenario `clean-item-throughput`
(≥ **K** easy items reach `pipeline:ready-to-deploy` without an engine-class
block). Issue #959 is synthetic pack item 1: a deliberately trivial clean
throughput item so the `factory-gate` pack has ready-to-deploy volume without
product feature work or FRG scoring changes. FRG closes the PR and issue without
merge after a pack pass.

## What Changes

- Add a **minimal docs or fixture-only** provenance artifact that identifies this
  change as FRG pack clean composition item 1 for release **1.34.0** / pack
  `factory-gate-v1` (one line under `docs/` or README, **or** a small run-scoped
  JSON fixture under `core/test/fixtures/frg/` with a unit test that pins
  `release_version` to `1.34.0`).
- Keep the OpenSpec change valid so pre-merge archive (or equivalent) can
  complete without an OpenSpec structural block.
- Open a PR and advance it to `pipeline:ready-to-deploy` without an
  engine-class block (the observable outcome the pack scores).
- **No** product feature work and **no** changes to release or FRG scoring
  code (`factory-reliability-gate.ts`, scoreboard, thresholds, driver).

## Acceptance criteria

- [ ] An OpenSpec change for this issue exists under
      `openspec/changes/frg-pack-clean-composition-item-1-v1-34-0/` (or is
      archived into living specs) and
      `openspec validate frg-pack-clean-composition-item-1-v1-34-0` (or
      `openspec validate --all` when archived) passes.
- [ ] The landed tree contains a minimal docs note **or** a run-scoped fixture
      (under `docs/` / README **or** `core/test/fixtures/frg/`) that names this
      work as FRG pack clean composition item 1 for release **1.34.0** (and does
      not claim product or scoring behavior changes).
- [ ] If a fixture path is used, a unit test loads only that path and fails when
      the pinned release identity is not `1.34.0`.
- [ ] The implementation diff does **not** modify FRG scoring, release
      preflight, factory-gate driver logic, or product feature surfaces outside
      that provenance/fixture artifact (and the OpenSpec change artifacts for
      this issue).
- [ ] A PR for this issue reaches label `pipeline:ready-to-deploy` without an
      engine-class block (clean throughput outcome for pack composition scoring).
- [ ] `npm run ci` passes on the PR head.
- [ ] FRG may close the PR and linked issue without merge after pack pass
      (existing post-pass disposition; this change does not re-implement close).

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `factory-reliability-gate`: ADDED documentation/fixture provenance requirement
  that synthetic clean composition pack items used for Layer B
  `clean-item-throughput` leave an in-tree one-line provenance note (docs/ or
  README) **or** a run-scoped test fixture naming pack role and target release
  version **1.34.0**. No change to FRG scoring thresholds, scenario ids, evidence
  schema, or driver pass/fail logic.

## Impact

- **Docs or test fixture only (implementation):** one-line note in `README.md`
  and/or `docs/factory-reliability-gate-runbook.md` (or an adjacent `docs/`
  file), **or** a small JSON fixture under `core/test/fixtures/frg/` plus one
  unit test.
- **OpenSpec:** this change folder; archive into
  `openspec/specs/factory-reliability-gate/` at pre-merge if still active.
- **Out of scope:** `core/scripts/factory-reliability-gate.ts`, release
  sub-command, FRG thresholds (K/N/engine-class rate), scoreboard metrics,
  product features, auto-merge, review-rigor demotion, re-implementing FRG
  auto-close.
