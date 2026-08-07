## ADDED Requirements

### Requirement: Factory macro-controller linkage SHALL NOT create a second authoritative loop engine

When a factory macro-controller links or starts a durable multi-item loop run, Agent Pipeline's existing durable loop engine and store SHALL remain the sole authoritative ledger, lock, run-id namespace, and run directory for that loop run. The factory store MAY record the loop run id and contract hash as a link on a factory execution-contract revision, but SHALL NOT introduce a parallel item transition ledger, a second lock that authorizes loop item transitions, or a second run-id namespace that item stages must consult. The per-item advance state machine SHALL continue to own exactly one issue at a time and SHALL NOT gain factory phase transitions as stage labels.

#### Scenario: Linked loop run keeps one ledger

- **WHEN** the factory macro-controller starts a multi-item loop for an adopted factory contract
- **THEN** item state transitions SHALL be recorded only in the durable loop run's ledger under the existing engine rules
- **AND** the factory store SHALL hold a link to that run id rather than a duplicate item-by-item stage ledger

#### Scenario: No second lock authorizes item transitions

- **WHEN** a loop item transition is attempted
- **THEN** authorization SHALL still require the durable loop run lock token under existing store rules
- **AND** possession of only the factory-run lock SHALL NOT be sufficient to mutate the loop ledger

#### Scenario: Advance state machine remains single-issue

- **WHEN** factory coarse phases change (for example from executing to merge_prepare)
- **THEN** those phases SHALL NOT appear as pipeline stage labels that the per-item advance state machine transitions through for ordinary issues
