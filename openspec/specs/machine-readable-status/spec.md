# machine-readable-status Specification

## Purpose
TBD - created by archiving change desktop-json-status-preflight. Update Purpose after archive.
## Requirements
### Requirement: `pipeline <issue> --status --json` SHALL emit a single unfenced JSON object

When the `--json` flag is passed alongside `--status`, the pipeline CLI SHALL write exactly one JSON object to stdout. The output SHALL NOT be wrapped in a markdown code fence, preceded by prose, or followed by trailing non-JSON bytes. The envelope SHALL be valid JSON even when the issue cannot be found or the GitHub request fails — errors SHALL be represented as `"status": "error"` with an `"error"` string field inside the envelope.

#### Scenario: JSON flag produces unfenced JSON

- **WHEN** `pipeline <issue> --status --json` is invoked for a valid issue
- **THEN** stdout SHALL contain exactly one JSON object with no surrounding prose or code fences
- **AND** `JSON.parse(stdout)` SHALL succeed

#### Scenario: Error during status fetch encoded in envelope

- **WHEN** `pipeline <issue> --status --json` is invoked and the GitHub request fails
- **THEN** stdout SHALL still be a valid JSON object
- **AND** the object SHALL contain `"status": "error"` and an `"error"` field describing the failure
- **AND** the command SHALL exit with a non-zero exit code

#### Scenario: `--status` without `--json` is unchanged

- **WHEN** `pipeline <issue> --status` is invoked without `--json`
- **THEN** stdout SHALL be identical to the pre-change prose output
- **AND** no JSON is emitted

### Requirement: The JSON status envelope SHALL include a required set of fields

The JSON object produced by `--status --json` SHALL include the following fields at minimum:

- `schema_version` (string): envelope version identifier, e.g. `"1"`.
- `status` (string): top-level discriminant. Values: `"ok"`, `"blocked"`, `"needs-human"`, `"waiting"`, `"error"`.
- `issue` (object): `{ number: number, title: string }`.
- `stage` (string): the current pipeline stage label value (e.g. `"review-1"`), or `null` if no pipeline label is present.
- `pr` (object | null): `{ number: number, url: string }` when a PR exists, otherwise `null`.
- `branch` (string | null): the feature branch name when known, otherwise `null`.
- `worktree` (string | null): absolute path to the active worktree when known, otherwise `null`.
- `last_event` (object | null): `{ timestamp: string (ISO 8601), description: string }` for the most recent pipeline event (label change or pipeline comment), or `null` if none.
- `review_summary` (object | null): `{ verdict: string, findings_count: number, timestamp: string (ISO 8601) }` from the latest review verdict, or `null` if no review has run.
- `next_action` (string): human-readable description of what the pipeline will do on the next invocation.
- `config` (object): `{ repo: string, domain: string }`.

Additive fields beyond this minimum SHALL be permitted and SHALL NOT constitute a breaking change.

#### Scenario: All minimum fields present on a normal issue

- **WHEN** `pipeline <issue> --status --json` is invoked for an issue at stage `review-1` with an open PR
- **THEN** the returned JSON SHALL include every field listed in the minimum set
- **AND** `schema_version` SHALL equal `"1"`
- **AND** `pr` SHALL be a non-null object with `number` and `url`

#### Scenario: Null fields when information is unavailable

- **WHEN** `pipeline <issue> --status --json` is invoked for an issue that has no associated PR yet
- **THEN** `pr` SHALL be `null`
- **AND** `branch` MAY be `null`
- **AND** `worktree` MAY be `null`
- **AND** all other minimum fields SHALL still be present

#### Scenario: `stage` is null when issue has no pipeline label

- **WHEN** `pipeline <issue> --status --json` is invoked for an issue with no `pipeline:*` label
- **THEN** `stage` SHALL be `null`
- **AND** `status` SHALL be `"blocked"` or `"error"`

### Requirement: JSON status output SHALL be covered by unit tests using the injectable deps seam

The status JSON assembly logic SHALL be exercisable through the existing `deps`/`Deps` injectable seam (providing `gh` fakes). Unit tests SHALL verify the minimum field set and SHALL perform no real network, git, or subprocess calls.

#### Scenario: Unit test verifies minimum fields with fake deps

- **WHEN** a unit test injects `gh` fakes returning a known issue and PR state
- **AND** calls the JSON status assembly function
- **THEN** the returned object SHALL contain every minimum field
- **AND** `schema_version` SHALL equal `"1"`

#### Scenario: Unit test verifies null fields when PR absent

- **WHEN** a unit test injects `gh` fakes where no PR exists for the issue
- **AND** calls the JSON status assembly function
- **THEN** `pr` SHALL be `null`

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

