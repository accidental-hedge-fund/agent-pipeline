## ADDED Requirements

### Requirement: The JSON status envelope SHALL flag a possibly-wedged non-finalized run

The JSON object produced by `pipeline <issue> --status --json` SHALL include a `possibly_wedged` field that distinguishes a legitimately long-running stage from a wedged run. `possibly_wedged` SHALL be a non-null object `{ last_event_age_ms: number, threshold_ms: number, last_event_type: string }` when both (1) the run is not finalized — its `events.jsonl` contains no `run_complete` event — and (2) the newest `events.jsonl` entry is older than the largest configured stage timeout (the maximum over the configured per-stage timeouts). Otherwise — a finalized run, or a run whose newest event is within the threshold — `possibly_wedged` SHALL be `null`. The field is additive; the envelope `schema_version` SHALL remain `"1"`, and every other minimum status field SHALL continue to be present.

#### Scenario: unfinalized run with a stale last event is flagged

- **WHEN** `pipeline <issue> --status --json` is invoked for a run whose `events.jsonl` has no `run_complete` event
- **AND** the newest event's timestamp is older than the largest configured stage timeout
- **THEN** `possibly_wedged` SHALL be a non-null object
- **AND** it SHALL contain `last_event_age_ms`, `threshold_ms`, and `last_event_type`

#### Scenario: finalized run is never flagged

- **WHEN** `pipeline <issue> --status --json` is invoked for a run whose `events.jsonl` contains a `run_complete` event
- **THEN** `possibly_wedged` SHALL be `null` regardless of the last event's age

#### Scenario: recent activity is not flagged

- **WHEN** `pipeline <issue> --status --json` is invoked for an unfinalized run whose newest event is within the largest configured stage timeout
- **THEN** `possibly_wedged` SHALL be `null`

#### Scenario: possibly_wedged is additive and does not disturb the minimum field set

- **WHEN** `pipeline <issue> --status --json` is invoked
- **THEN** the envelope SHALL still contain every field in the existing minimum status set
- **AND** `schema_version` SHALL equal `"1"`

### Requirement: The possibly-wedged computation SHALL be covered by unit tests using the injectable deps seam

The `possibly_wedged` computation SHALL be exercisable through the existing `deps` seam using a fake `events.jsonl` and configured timeouts, performing no real network, git, or subprocess calls. Tests SHALL cover the flagged case (unfinalized run with a stale newest event) and the two unflagged cases (finalized run; unfinalized run with a recent newest event).

#### Scenario: unit test flags a stale unfinalized run

- **WHEN** a unit test supplies a fake unfinalized `events.jsonl` whose newest event predates the largest configured stage timeout
- **THEN** the status assembly SHALL return a non-null `possibly_wedged` with `last_event_age_ms`, `threshold_ms`, and `last_event_type`

#### Scenario: unit test does not flag a finalized or recent run

- **WHEN** a unit test supplies a fake `events.jsonl` that either contains a `run_complete` event or whose newest event is within the threshold
- **THEN** the status assembly SHALL return `possibly_wedged: null`
