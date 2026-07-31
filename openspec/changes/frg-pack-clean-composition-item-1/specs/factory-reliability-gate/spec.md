## ADDED Requirements

### Requirement: Synthetic clean composition pack items SHALL leave in-tree pack provenance

Synthetic pack work items used solely to contribute to FRG Layer B scenario `clean-item-throughput` SHALL leave a minimal in-tree provenance note under `docs/` or as a one-line note in the README. The note SHALL name the pack role (clean composition item index or equivalent) and the target release version (for example `1.29.1`). The note SHALL NOT require changes to FRG scoring code, release preflight, evidence schema, thresholds, or scenario inventory. Product feature work SHALL NOT be required for a clean composition pack item to satisfy this provenance requirement.

#### Scenario: Clean composition item 1 for 1.29.1 has a provenance note

- **WHEN** the synthetic FRG pack clean composition item for release `1.29.1`
  (pack item 1 / `clean-item-throughput` contributor) is implemented
- **THEN** the repository tree SHALL contain a docs or README provenance note
  that names the clean composition pack role and release `1.29.1`
- **AND** the implementation SHALL NOT modify FRG scoring, factory-gate driver
  pass/fail logic, or release preflight solely to satisfy that pack item

#### Scenario: Provenance note does not invent a new scenario id

- **WHEN** an operator reads the clean composition provenance note
- **THEN** the note SHALL refer to existing pack vocabulary
  (`clean-item-throughput`, factory-gate / `factory-gate-v1`, or clean
  composition item index)
- **AND** SHALL NOT introduce a new required FRG scenario id beyond the fixed
  pack inventory

### Requirement: Clean composition pack items SHALL be eligible for ready-to-deploy without engine-class block as their pack outcome

A synthetic clean composition pack item for FRG Layer B SHALL be scoped so that a correct implementation can reach label `pipeline:ready-to-deploy` without an engine-class block. The pack-scored outcome for such an item is clean ready-to-deploy throughput, not a product behavior change. Engine-class blocks caused by defects in the factory (capacity cascade, resume strand, OpenSpec archive false-pass, and other engine-class themes defined by the FRG taxonomy) SHALL count against the item for FRG scoreboard purposes when they occur; the item's own change set SHALL not deliberately introduce product-class or engine-class failure modes.

#### Scenario: Item reaches ready-to-deploy as clean throughput

- **WHEN** the clean composition pack item's PR has a valid OpenSpec change
  (when OpenSpec is used), a docs/comment-only provenance implementation, and
  green `npm run ci`
- **AND** no engine-class defect blocks the run
- **THEN** the issue SHALL be able to receive `pipeline:ready-to-deploy`
- **AND** that outcome SHALL count toward FRG scenario `clean-item-throughput`
  for the release under test when the fixed pack loop scores the run
