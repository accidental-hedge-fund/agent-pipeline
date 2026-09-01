## ADDED Requirements

### Requirement: Admission and nested-child events SHALL stamp logical_operation_id

`run_start` and other admission-time events for numeric drive, `single`, `loop`, `train`, `merge`, merge queue, and `ship` SHALL include `logical_operation_id` as an additive field. Nested child events SHALL carry the parent identity. `schema_version` SHALL remain `1`. Readers SHALL preserve the field on unknown-field pass-through. Retries and fresh-process resumes that present a valid resume binding SHALL reuse the original identity on the new physical run's events.

#### Scenario: run_start carries logical_operation_id

- **WHEN** `initRunDir` completes for a new public admission
- **THEN** the `run_start` event SHALL contain `logical_operation_id` in addition to `run_id`
- **AND** `schema_version` SHALL remain `1`

#### Scenario: Fresh-process resume does not mint a second identity on events

- **WHEN** a fresh process resumes the same logical operation through a valid resume binding
- **THEN** events on the new physical run SHALL carry the original `logical_operation_id`
- **AND** SHALL NOT introduce a different logical identity for the same admission

#### Scenario: Readers preserve the additive field

- **WHEN** an older reader parses an event that includes `logical_operation_id`
- **THEN** `readEvents()` SHALL include that field unchanged
