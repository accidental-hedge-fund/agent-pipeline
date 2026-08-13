## ADDED Requirements

### Requirement: Scratch-only composition regressions SHALL be guarded by automated tests

In addition to product scratch-recover contracts (shared classifier, unlink without `setBlocked` for scratch-only porcelain, residual engine blocks as `harness-failure` / `workflow-engine-defect`, `unlink_engine_scratch` before `repair_pipeline_item`), the test suite SHALL include automated composition coverage that fails when those contracts regress on the ship path. At minimum the suite SHALL fail if: (1) scratch-only engine porcelain parks as `pipeline:needs-human` or block kind `needs-human` / `human-decision-required`, or `setBlocked` solely for that porcelain; (2) scratch-only recovery invokes `repair_pipeline_item` for that attempt instead of deterministic unlink/clear. Product dirt hard-blocks remain correct and SHALL NOT be treated as composition failures. Tests SHALL inject deps and SHALL perform zero real network, git, or subprocess calls.

#### Scenario: Scratch-only needs-human composition fails CI

- **WHEN** a hermetic test presents scratch-only porcelain under the engine-known set to a dirt gate or recovery composition path
- **AND** the system under test escalates as `needs-human` / `pipeline:needs-human` or `setBlocked` solely for that porcelain
- **THEN** the test SHALL fail under the unit suite consumed by `npm run ci`

#### Scenario: Scratch-only repair composition fails CI

- **WHEN** a hermetic test drives scratch-only recovery
- **AND** the system under test invokes `repair_pipeline_item` for that attempt without successful scratch-only unlink/clear
- **THEN** the test SHALL fail

#### Scenario: Product dirt hard-block is not a composition failure

- **WHEN** porcelain includes product paths and the gate hard-blocks with product disclosure
- **THEN** the scratch-only composition suite SHALL NOT fail solely for that hard-block
