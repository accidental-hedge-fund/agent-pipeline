## ADDED Requirements

### Requirement: Clean composition pack items SHALL leave checked-in FRG pack provenance

Clean composition pack items SHALL leave a checked-in provenance marker under `docs/` and/or a one-line note in `README.md` when they are synthetic Layer B members that exist to satisfy `clean-item-throughput` (easy items intended to reach `pipeline:ready-to-deploy` without an engine-class block). The marker SHALL name the FRG pack release version and the pack item identity (for example "clean composition item 2" for version `1.29.1`). The deliverable for such an item SHALL be docs/comment-only: it SHALL NOT introduce product feature work and SHALL NOT change FRG scoring, driver, evidence schema, or release-tag automation.

#### Scenario: Provenance note is present for a clean pack item

- **WHEN** a synthetic clean composition pack item for FRG version `1.29.1` is
  implemented as pack item 2
- **THEN** the repository SHALL contain a checked-in docs or README provenance
  note that identifies FRG pack clean composition item 2 for `1.29.1`
- **AND** the change SHALL NOT modify FRG scoring or driver code

#### Scenario: Clean pack item remains non-product scope

- **WHEN** the PR for a clean composition pack item is reviewed for scope
- **THEN** the diff SHALL be limited to documentation, comments, and OpenSpec
  change artifacts for that item
- **AND** it SHALL NOT add product features, auto-merge configuration, or
  release-tag automation

#### Scenario: Clean pack item is eligible for clean-item-throughput scoring

- **WHEN** the clean composition pack item PR reaches `pipeline:ready-to-deploy`
  without an engine-class block
- **THEN** that outcome SHALL count toward FRG scenario `clean-item-throughput`
  for the fixed factory-gate pack (subject to the runbook threshold K)
- **AND** an engine-class block on that item SHALL prevent treating it as a clean
  ready outcome for that scenario
