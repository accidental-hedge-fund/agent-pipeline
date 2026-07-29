## ADDED Requirements

### Requirement: Production work-list compilation SHALL supply declared raw dependencies into snapshot compilation

The durable engine (or its Pipeline work-list facade) SHALL supply each item's **raw
declared** prerequisite ids — discovered per the `work-list-declared-dependency-population`
capability — into the snapshot compilation step that partitions `depends_on` vs
`external_depends_on` when compiling a contract from a resolved list of issue ids for a new
run. It SHALL NOT systematically discard all declarations by compiling every item as
`depends_on: []` when authoritative sources declare otherwise. Dependency ordering, cycle
refusal, and external preservation SHALL continue to follow the existing "Dependency
ordering SHALL be deterministic and SHALL reject cycles" requirement once those raw
declarations are supplied.

#### Scenario: Work-list compile feeds declared edges into partition

- **WHEN** a new work-list run is compiled from issues that declare inter-item dependencies
- **THEN** snapshot compilation SHALL receive non-empty raw `depends_on` values for those
  declaring items
- **AND** the resulting contract items SHALL reflect the in-snapshot / external partition of
  those declarations

#### Scenario: Independent items remain valid

- **WHEN** a new work-list run is compiled from issues with no declared dependencies
- **THEN** snapshot compilation SHALL still succeed with empty dependency lists per item
- **AND** the engine SHALL treat those items as dependency-independent for scheduling
