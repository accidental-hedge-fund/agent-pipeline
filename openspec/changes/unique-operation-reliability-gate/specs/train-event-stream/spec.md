## ADDED Requirements

### Requirement: Train loop linkage SHALL propagate logical_operation_id

`train_loop_linked` and the child `onRunReady` handoff SHALL include the train admission `logical_operation_id` together with the existing exact child loop `run_id` and events path. Nested child runs SHALL inherit that identity. The stream SHALL NOT guess a child identity by latest-run lookup or stdout scraping. This requirement consumes #1301 live linkage; it SHALL NOT replace train scheduling, merge authority, or collision-safe physical run-id allocation.

#### Scenario: Linked child carries the train logical identity

- **WHEN** train emits `train_loop_linked` for a nested loop
- **THEN** that event SHALL include the train `logical_operation_id`
- **AND** the child loop run SHALL persist the same logical identity

#### Scenario: Duplicate handoff does not mint a second logical identity

- **WHEN** a later wave result confirms the same child loop already linked
- **THEN** the confirmed identity SHALL match the original `logical_operation_id`
- **AND** SHALL NOT replace it with a guessed run
