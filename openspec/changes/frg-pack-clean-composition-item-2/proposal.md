## Why

The Factory Reliability Gate (FRG) Layer B fixed pack for release **1.29.1** needs
multi-item `pipeline:ready-to-deploy` throughput so scenario `clean-item-throughput`
can score against threshold **K ≥ 2**. This change is a **synthetic pack composition
item** (item 2): intentionally trivial work that proves the durable loop can carry a
second easy item to ready-to-deploy without an engine-class block. It is not product
feature work; it exists so the factory-gate pack has enough clean ready outcomes.

## What Changes

- Add a **minimal docs or comment-only provenance note** under `docs/` or a one-line
  README note that records this item as FRG pack clean composition item 2 for
  **v1.29.1** (pack provenance only).
- Open an associated PR and advance it to `pipeline:ready-to-deploy` without an
  engine-class block (the observable Layer B clean-item outcome).
- Keep OpenSpec for this change **valid** and ready to archive at pre-merge (or
  document that no further product requirement is needed beyond this delta).

No product features, no FRG scoring/driver changes, no release-tag or merge automation.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `factory-reliability-gate`: Record that Layer B clean composition pack members for
  release FRG runs SHALL leave a checked-in provenance marker (docs/README one-liner)
  identifying pack version and item identity, without expanding product or scoring
  surface area.

## Impact

- **Docs only:** one line (or short note) in `docs/` (preferred: FRG runbook or a
  small provenance subsection) and/or `README.md`.
- **Pipeline surface:** issue #750 / this PR as a clean pack member for
  `clean-item-throughput` scoring on the fixed factory-gate pack.
- **OpenSpec:** this change under `openspec/changes/frg-pack-clean-composition-item-2/`
  validates and archives at pre-merge like any other in-flight change.
- **Out of scope:** product features; `core/scripts/factory-reliability-gate.ts` or
  other FRG scoring/driver edits; release packaging; auto-merge; review-rigor demotion.

## Acceptance criteria

- [ ] OpenSpec change `frg-pack-clean-composition-item-2` validates (`openspec validate
      frg-pack-clean-composition-item-2` / gate `openspec validate --all`) and is
      archived or otherwise disposed at pre-merge without structural OpenSpec failure.
- [ ] The PR for this pack item opens and reaches `pipeline:ready-to-deploy` without
      an engine-class block.
- [ ] Diff is docs/comment-only: a provenance note under `docs/` and/or a one-line
      README note naming FRG pack clean composition item 2 for v1.29.1.
- [ ] No product feature code, no FRG scoring/driver changes, no auto-merge or
      release-tag path changes land in this PR.
- [ ] `npm run ci` passes on the PR head.
