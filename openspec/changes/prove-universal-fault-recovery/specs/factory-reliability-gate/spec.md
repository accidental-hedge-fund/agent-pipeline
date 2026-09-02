## ADDED Requirements

### Requirement: FRG #1333 coverage SHALL be produced by executed matrix rows rather than stamped helpers

Release-eligible FRG unique-operation evidence SHALL set `covered_lifecycle_classes` only from executed universal-fault-recovery-matrix rows for the scored candidate. Each executed row SHALL bind to a declared applicable matrix cell (operation, fault/state, public entry point, host, layer) and that cell's expected typed terminal. Helper fixtures that declare every required lifecycle class without those rows SHALL NOT satisfy #1333 coverage. Class/layer records that do not bind to a declared cell SHALL NOT satisfy coverage. Absence of those rows SHALL fail FRG promotion as missing required coverage. This capability SHALL NOT create a second scheduler, recovery owner, or fault-matrix runner.

#### Scenario: Stamped helper coverage fails promotion

- **WHEN** a unique-operation helper declares all five required lifecycle classes
- **AND** the scored candidate has no executed matrix rows for those classes
- **THEN** FRG promotion SHALL fail
- **AND** the integrity report SHALL name missing required coverage, not a stable exclusion

#### Scenario: Executed matrix rows satisfy #1333 coverage

- **WHEN** the scored candidate has passing matrix rows for every required lifecycle class on every applicable coverage layer
- **AND** unique-operation false-human and ownerless-terminal counts for those mechanical rows are zero
- **THEN** the #1333 coverage proof SHALL be present
- **AND** FRG MAY pass the unique-operation coverage check for those classes

#### Scenario: Fabricated class/layer records fail promotion

- **WHEN** unique-operation evidence supplies passed records that name lifecycle class and layer for the scored candidate
- **AND** those records do not match a declared applicable matrix cell and its expected typed terminal
- **THEN** FRG promotion SHALL fail
- **AND** the integrity report SHALL name missing required coverage, not a stable exclusion

## MODIFIED Requirements

### Requirement: FRG unique-operation scoring SHALL require integrated #1301 and #1333 proofs

Release-eligible FRG pass SHALL require the #1301 live train-loop linkage, collision-safe train run identity, and merge-proof events, and SHALL require the #1333 mechanical fault matrix to cover every required lifecycle class for the scored candidate. Absence of those proofs SHALL fail FRG promotion. Helper fixtures that stamp required lifecycle classes without executed matrix rows SHALL NOT satisfy the #1333 proof. This capability SHALL NOT create a second scheduler, recovery owner, or fault-matrix runner.

#### Scenario: Missing #1333 coverage fails promotion

- **WHEN** a required lifecycle class in the #1333 matrix is uncovered for the candidate
- **THEN** FRG promotion SHALL fail
- **AND** the integrity report SHALL name missing required coverage, not a stable exclusion

#### Scenario: Stamped coverage without matrix rows fails promotion

- **WHEN** unique-operation evidence lists required lifecycle classes as covered
- **AND** the universal-fault-recovery-matrix inventory has no executed covering row for a required class
- **THEN** FRG promotion SHALL fail
- **AND** the gap SHALL NOT be recorded as a stable exclusion

#### Scenario: Missing #1301 live linkage fails promotion

- **WHEN** a train-driven nested loop has no followable `train_loop_linked` identity from the child `onRunReady` handoff
- **THEN** FRG promotion SHALL fail as missing correlation or missing required coverage
- **AND** the driver SHALL NOT guess the child run by latest-run lookup
- **AND** a `train_loop_linked` event that carries only the parent logical id SHALL NOT count as followable child linkage
