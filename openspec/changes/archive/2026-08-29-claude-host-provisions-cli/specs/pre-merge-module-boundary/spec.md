## REMOVED Requirements

### Requirement: Core changes SHALL keep the generated plugin mirror in sync

**Reason:** Issue #1048 removes the generated `plugin/` core mirror and retains only SKILL/catalog freshness outputs.

**Migration:** Core changes continue to run `node scripts/build.mjs`; the gate checks generated packaging artifacts and forbids copies of moved core modules under `plugin/`.

## ADDED Requirements

### Requirement: Core changes SHALL keep generated packaging artifacts fresh

Any edit under `core/` that participates in this split SHALL be accompanied by running `node scripts/build.mjs` in the same change. CI’s SKILL/catalog freshness check (`node scripts/build.mjs --check`) SHALL pass without requiring a generated `plugin/` core mirror.

#### Scenario: Packaging freshness check passes after the split

- **WHEN** the split lands under `core/scripts/stages/`
- **THEN** `node scripts/build.mjs --check` SHALL report generated SKILL/catalog outputs in sync
- **AND** the change SHALL NOT add copies of the moved modules under `plugin/`
