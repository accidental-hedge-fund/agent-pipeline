## MODIFIED Requirements

### Requirement: Fresh multi-item or factory-owned run admission SHALL refuse incomplete discovery

Pipeline SHALL refuse admission with a typed, actionable result that names the incomplete
source and enough scope to act (issue id and/or list-level source) when it initializes a
**fresh** durable run that is multi-item (resolved snapshot contains two or more issues) or
factory-owned and any **enabled** authoritative discovery source observation for that
compile is `unavailable` or `incomplete`. Pipeline SHALL NOT initialize a run contract or
ledger for that refused attempt. A fresh multi-item `pipeline train` invocation is the same
class of admission: train SHALL NOT create a train run store or advance work for that
refused attempt. Successfully observed edges from other sources SHALL NOT override the
refuse when any enabled source remains incomplete.

#### Scenario: Incomplete native source blocks multi-item init

- **WHEN** a fresh multi-item work-list compile enables native `blockedBy` discovery
- **AND** that source is incomplete for at least one snapshot issue
- **THEN** compile/admission SHALL fail with a typed actionable result
- **AND** no run contract or ledger SHALL be created for that attempt

#### Scenario: Incomplete issue text blocks factory-owned init

- **WHEN** a fresh factory-owned multi-item compile cannot fully observe required issue
  title/body text for a snapshot issue
- **THEN** admission SHALL be refused
- **AND** no run contract or ledger SHALL be initialized

#### Scenario: Fully observed empty sources still admit independent items

- **WHEN** every enabled authoritative source for a fresh multi-item compile is fully
  observed and all are `observed-empty` for every item
- **THEN** admission MAY proceed
- **AND** compiled items SHALL remain independent (`depends_on` / `external_depends_on`
  empty) rather than inventing edges

#### Scenario: Incomplete native source blocks multi-item train before store init

- **WHEN** a fresh multi-item `pipeline train` invocation enables native `blockedBy`
  discovery
- **AND** that source is `unavailable` or `incomplete` for at least one selected issue
- **THEN** admission SHALL fail with a typed actionable result naming that native source
- **AND** no train run store SHALL be created for that attempt
- **AND** no advance wave or merge mutation SHALL run
