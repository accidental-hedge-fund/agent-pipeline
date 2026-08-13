## ADDED Requirements

### Requirement: FRG Layer A ownership SHALL not silently omit ship-path composition classes

When the repository maintains ship-path composition class ids under `ship-path-composition-coverage` (including at least frontier one-wave, code-dep merge barrier, independent R2D partial-failure merge, scratch-only no needs-human, and scratch-only unlink-not-repair), the FRG Layer A ownership map, composition inventory, or an explicit co-located ship-path composition inventory consulted by the unit suite SHALL record each hard class as either (1) covered by a hermetic test, or (2) waived with an open tracking issue. Silent omission of a hard ship-path composition class from both test coverage and waiver inventory SHALL NOT be permitted. This requirement does **not** expand the fixed Layer B scenario pack ids and does **not** require live network ship in CI. Hard classes for issue #1029 acceptance SHALL be satisfied by tests, not by waivers.

#### Scenario: Hard ship-path class missing from Layer A / composition inventory fails

- **WHEN** a hard ship-path composition class has neither a hermetic covering test registration nor an open-issue waiver entry in the consulted inventory
- **THEN** the inventory or Layer A ownership guard SHALL fail under the unit suite
- **AND** the failure SHALL name the missing class id

#### Scenario: Layer B pack ids remain frozen by this requirement

- **WHEN** this requirement is implemented
- **THEN** the fixed FRG Layer B scenario id list SHALL NOT be required to add new live pack scenario ids solely for ship-path composition
- **AND** hermetic / Layer A / unit composition SHALL remain sufficient for CI proof of these classes

#### Scenario: Hermetic ship-path composition is not release FRG pass alone

- **WHEN** ship-path composition unit tests pass without a conforming live FRG evidence artifact
- **THEN** the FRG release precondition for a version SHALL remain governed by existing FRG live-loop and attestation rules
- **AND** unit composition success SHALL NOT substitute for release-eligible FRG `pass: true`
