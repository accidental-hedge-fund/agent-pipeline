## ADDED Requirements

### Requirement: correction_event is a recognized event type in events.jsonl

The `events.jsonl` format SHALL recognize `"correction_event"` as a valid event `type`
alongside the existing lifecycle, `review_verdict`, `blocker_set`/`blocker_cleared`,
`human_intervention`, `stage_accounting`, and `papercut` types. A `correction_event` SHALL be
appended through the same `appendEvent` chokepoint as every other event, so it inherits
`--json-events` stdout streaming byte-for-byte. Each `correction_event` line SHALL carry the
base `schema_version`, `type`, and `at` fields plus the `correction_event` contract
(`correction_id`, `correction_key`, `source_kind`, `failure_class`, `actor_kind`, `issue`,
`repo`, `run_id`, `stage`, `reviewed_sha`, `head_sha`, `evidence_ref`, `correction`,
`reusable`, and optional `proposed_control`). Readers SHALL NOT reject or skip `correction_event`
lines when iterating the log, and stage-timeline reconstruction SHALL exclude them by type
filter. The `correction_event` type is additive and does not change `schema_version`.

#### Scenario: reader includes correction_event lines when iterating

- **WHEN** `readEvents()` is called on an `events.jsonl` containing a mix of `stage_complete` and `correction_event` events
- **THEN** every appended `correction_event` line SHALL be returned to the caller
- **AND** the reader SHALL NOT skip or drop `correction_event` lines

#### Scenario: correction_event streams under --json-events

- **WHEN** a `correction_event` is appended while `--json-events` is active
- **THEN** the identical JSON line SHALL be written to stdout, as for every other event type

#### Scenario: correction_event does not affect stage timeline reconstruction

- **WHEN** a stage timeline is reconstructed from an `events.jsonl` containing `correction_event` lines
- **THEN** `correction_event` lines SHALL be excluded by the type filter
- **AND** the stage timeline SHALL be identical to a log without `correction_event` lines
