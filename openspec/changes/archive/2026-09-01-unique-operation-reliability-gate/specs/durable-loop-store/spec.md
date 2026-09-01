## ADDED Requirements

### Requirement: Nested loop runs SHALL retain the parent logical_operation_id

When a durable loop run is spawned as nested child work of an admitted parent, the loop contract SHALL persist the parent's `logical_operation_id`. The store SHALL NOT mint a second logical identity for that nested run. Operator resume of the same loop-store run SHALL reuse the persisted id. The store SHALL remain the existing durable loop store; this requirement SHALL NOT introduce a second ledger, lock namespace, or scheduler.

#### Scenario: Nested loop contract stores the parent identity

- **WHEN** a parent train or ship admits a nested loop run with `logical_operation_id` `L`
- **THEN** the published loop contract SHALL record `L`
- **AND** the nested loop `run_id` MAY differ from the parent physical run id

#### Scenario: Loop resume keeps the persisted logical identity

- **WHEN** a later process resumes that loop-store run
- **THEN** the resumed loop SHALL use the persisted `logical_operation_id`
- **AND** SHALL NOT mint a new logical identity
