## ADDED Requirements

### Requirement: Train SHALL consume a single reconciled pipeline stage and SHALL NOT throw on multiple stage labels

When freeze, eligibility, or item classification reads GitHub labels, train SHALL consume the single observed stage derived from all `pipeline:*` labels whose suffix is a member of `STAGES`, using the greatest `STAGES` index when more than one is present. Train SHALL NOT throw because two or more such labels are present. Train SHALL NOT STOP the work list solely for that observation. The item SHALL remain RecoverySupervisor-owned. Train SHALL NOT write GitHub labels during that derivation.

#### Scenario: Contradictory stage labels do not STOP the train

- **WHEN** a freeze-eligible issue carries `pipeline:pre-merge` and `pipeline:design-gate`
- **THEN** train SHALL treat the observed stage as `pre-merge`
- **AND** SHALL NOT throw `ambiguous pipeline stage labels`
- **AND** SHALL NOT STOP the train solely for those labels
- **AND** independent siblings SHALL remain schedulable

#### Scenario: Train derivation matches loop derivation

- **WHEN** loop reconciliation and train freeze classify the same label list
- **THEN** both SHALL return the same observed stage
- **AND** neither SHALL throw
