## MODIFIED Requirements

### Requirement: Key run lifecycle events are recorded in events.jsonl
The orchestrator SHALL append a `run_start` event immediately after the run directory is created and a `run_complete` event at finalization. Additional events SHALL be appended for significant state changes: `pr_created` (PR opened), `pr_updated` (PR updated), `worktree_created`, `worktree_removed`, `review_verdict` (per review round), `blocker_set`, and `blocker_cleared`. Each event type SHALL carry its type-specific fields in addition to the base `schema_version`, `type`, and `at` fields.

The `review_verdict` event SHALL additionally carry a `findings` array — one record per finding enumerated by the round — and the reviewer identity for the round (`reviewer_harness`, `reviewer_model`, `self_review`). Each finding record SHALL contain `key` (the stable `findingKey`), `severity`, `title`, `body`, `confidence`, and `recommendation`, and SHALL contain `file`, `line_start`, `line_end`, `category`, and `blocking` when the finding carries them. The `findings` array and reviewer-identity fields are additive optional fields, so `schema_version` SHALL remain `1`; their text fields SHALL be screened by the write-time injection denylist and secret redaction before the line is appended.

#### Scenario: run_start event appended at init
- **WHEN** `initRunDir(...)` completes successfully
- **THEN** a `run_start` event SHALL be appended to `events.jsonl`
- **AND** the event SHALL contain `issue`, `repo`, and `run_id` in addition to the base fields

#### Scenario: run_complete event appended at finalization
- **WHEN** `finalizeRun(...)` is called
- **THEN** a `run_complete` event SHALL be appended to `events.jsonl` before `summary.json` is written
- **AND** the event SHALL contain `final_state` and `elapsed_ms`

#### Scenario: review_verdict event contains structured data
- **WHEN** a review round completes and a verdict is parsed
- **THEN** a `review_verdict` event SHALL be appended to `events.jsonl`
- **AND** the event SHALL contain `round` (integer), `sha` (string), `verdict` (string), and `finding_counts` (object)

#### Scenario: review_verdict event carries per-finding records
- **WHEN** a review round enumerates one or more findings
- **THEN** the `review_verdict` event SHALL contain a `findings` array with one record per finding
- **AND** each record SHALL contain `key`, `severity`, `title`, `body`, `confidence`, and `recommendation`
- **AND** `file`, `line_start`, `line_end`, `category`, and `blocking` SHALL be present when the finding carries them

#### Scenario: review_verdict event carries reviewer identity
- **WHEN** a review round completes
- **THEN** the `review_verdict` event SHALL contain `reviewer_harness` (the harness that actually reviewed), `reviewer_model`, and `self_review` (boolean)

#### Scenario: review_verdict with zero findings carries an empty array
- **WHEN** a review round produces a verdict with no enumerated findings
- **THEN** the `review_verdict` event SHALL contain `findings: []`
- **AND** SHALL still contain `round`, `sha`, `verdict`, and `finding_counts`

#### Scenario: blocker_set and blocker_cleared events enable blocking state reconstruction
- **WHEN** the pipeline sets a blocking condition
- **THEN** a `blocker_set` event SHALL be appended with a `reason` string
- **WHEN** the blocking condition is cleared
- **THEN** a `blocker_cleared` event SHALL be appended
