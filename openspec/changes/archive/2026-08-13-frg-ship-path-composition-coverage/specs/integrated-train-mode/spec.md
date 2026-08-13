## ADDED Requirements

### Requirement: Train composition regressions SHALL be guarded by automated tests

In addition to the product train contracts (one multi-item advance wave per base-eligible frontier, code-dep merge barrier before child advance, serial merge waves, independent R2D sibling merge under proven independence, production multi-item loop wiring), the test suite SHALL include automated composition coverage that fails when those contracts regress. At minimum the suite SHALL fail if: (1) train returns to N×`single` / multiple advance-wave calls for one multi-item frontier or production N×`single` wiring; (2) a code-dependent child is advanced before prerequisite merge-result containment; (3) a proven-independent already ready-to-deploy sibling is not merged (or the train aborts before that merge) solely because a peer is parked or blocked. These tests SHALL inject deps and SHALL perform zero real network, git, or subprocess calls.

#### Scenario: N×single frontier composition fails CI

- **WHEN** a hermetic train composition test observes more than one multi-item advance-wave call for a single multi-item base-eligible frontier, or production wiring defaults to N×`single`
- **THEN** the test SHALL fail under the unit suite consumed by `npm run ci`

#### Scenario: Independent R2D merge under partial failure is regression-guarded

- **WHEN** a hermetic test places one item parked/blocked and a proven-independent sibling at ready-to-deploy under merge mode
- **AND** the system under test fails to merge the independent sibling solely because of the parked peer
- **THEN** the test SHALL fail

#### Scenario: Code-dep barrier is regression-guarded

- **WHEN** a hermetic test models code dependency A→B without A’s merge-result on base
- **AND** the system under test advances B in an advance wave
- **THEN** the test SHALL fail
