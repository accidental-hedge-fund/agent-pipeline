## ADDED Requirements

### Requirement: Synthetic clean composition pack items for release 1.34.0 SHALL leave in-tree pack provenance

Synthetic pack work items used solely to contribute to FRG Layer B scenario `clean-item-throughput` for release `1.34.0` SHALL leave a minimal in-tree provenance artifact. The artifact SHALL be either (1) a docs or README provenance note under `docs/` or as a one-line note in the README, or (2) a run-scoped JSON fixture under `core/test/fixtures/frg/` with a hermetic unit test that pins the release identity. The artifact SHALL name the pack role (clean composition item index or equivalent) and the target release version `1.34.0`. The artifact SHALL NOT require changes to FRG scoring code, release preflight, evidence schema, thresholds, or scenario inventory. Product feature work SHALL NOT be required for a clean composition pack item to satisfy this provenance requirement.

#### Scenario: Clean composition item 1 for 1.34.0 has a provenance artifact

- **WHEN** the synthetic FRG pack clean composition item for release `1.34.0`
  (pack item 1 / `clean-item-throughput` contributor, issue #959) is implemented
- **THEN** the repository tree SHALL contain a docs/README provenance note **or**
  a run-scoped fixture under `core/test/fixtures/frg/` that names the clean
  composition pack role and release `1.34.0`
- **AND** the implementation SHALL NOT modify FRG scoring, factory-gate driver
  pass/fail logic, or release preflight solely to satisfy that pack item

#### Scenario: Provenance artifact does not invent a new scenario id

- **WHEN** an operator or test reader inspects the clean composition provenance
  artifact for release `1.34.0`
- **THEN** the artifact SHALL refer to existing pack vocabulary
  (`clean-item-throughput`, factory-gate / `factory-gate-v1`, or clean
  composition item index)
- **AND** SHALL NOT introduce a new required FRG scenario id beyond the fixed
  pack inventory

#### Scenario: Fixture form pins release_version when used

- **WHEN** the implementer chooses the run-scoped fixture form for clean
  composition item 1 for release `1.34.0`
- **THEN** the fixture SHALL declare a release identity field equal to the
  string `1.34.0`
- **AND** a unit test that loads only that fixture path SHALL fail if the
  release identity is not `1.34.0`
- **AND** that unit test SHALL NOT call real network, git, or subprocess APIs

### Requirement: Clean composition pack items for 1.34.0 SHALL be eligible for ready-to-deploy without engine-class block as their pack outcome

A synthetic clean composition pack item for FRG Layer B release `1.34.0` SHALL be scoped so that a correct implementation can reach label `pipeline:ready-to-deploy` without an engine-class block. The pack-scored outcome for such an item is clean ready-to-deploy throughput, not a product behavior change. Engine-class blocks caused by defects in the factory (capacity cascade, resume strand, OpenSpec archive false-pass, and other engine-class themes defined by the FRG taxonomy) SHALL count against the item for FRG scoreboard purposes when they occur; the item's own change set SHALL not deliberately introduce product-class or engine-class failure modes. This item alone SHALL NOT claim to satisfy full release-eligible representative pack composition.

#### Scenario: Item reaches ready-to-deploy as clean throughput

- **WHEN** the clean composition pack item's PR has a valid OpenSpec change
  (when OpenSpec is used), a docs or fixture-only provenance implementation, and
  green `npm run ci`
- **AND** no engine-class defect blocks the run
- **THEN** the issue SHALL be able to receive `pipeline:ready-to-deploy`
- **AND** that outcome SHALL count toward FRG scenario `clean-item-throughput`
  for release `1.34.0` when the fixed pack loop scores the run

#### Scenario: FRG may close without merge after pack pass

- **WHEN** a release-eligible or pack-scored FRG pass records this item as
  `ready_clean` with an open PR
- **THEN** the existing FRG post-pass disposition MAY close the PR and linked
  issue without merge
- **AND** this pack item's implementation SHALL NOT add a merge path
