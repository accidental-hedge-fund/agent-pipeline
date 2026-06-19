# events-jsonl-streaming Specification

## Purpose
TBD - created by archiving change desktop-run-artifact-contract. Update Purpose after archive.
## Requirements
### Requirement: events.jsonl is an append-only atomic event log
The run directory SHALL contain `events.jsonl` — a log file where each line is a complete, newline-terminated JSON object. Each write SHALL use O_APPEND semantics so that concurrent or sequential writers do not corrupt prior entries. Lines SHALL be written atomically as a single OS write syscall. A reader SHALL tolerate: (1) a missing file — treated as an empty log; (2) a corrupt or partial final line — skipped silently; (3) unknown fields in any record — preserved in the parsed output unchanged.

#### Scenario: events.jsonl created at run directory init
- **WHEN** `initRunDir(...)` is called
- **THEN** `events.jsonl` SHALL exist in the run directory (empty or with a `run_start` event)

#### Scenario: appended line is valid JSON with required fields
- **WHEN** `appendEvent(event)` is called with a valid event object
- **THEN** a newline-terminated JSON line SHALL be appended to `events.jsonl`
- **AND** the line SHALL parse as JSON and contain at minimum `schema_version`, `type`, and `at` fields

#### Scenario: reader tolerates a corrupt or partial tail line
- **WHEN** `events.jsonl` contains a partial or unparseable final line (e.g., from a mid-write crash)
- **THEN** `readEvents()` SHALL return all fully parseable prior lines
- **AND** SHALL NOT throw an error or return the corrupt line in the result

#### Scenario: reader returns empty array for missing file
- **WHEN** `events.jsonl` does not exist
- **THEN** `readEvents()` SHALL return an empty array without throwing

#### Scenario: reader preserves unknown fields
- **WHEN** an event record in `events.jsonl` contains fields not known to the current reader version
- **THEN** `readEvents()` SHALL include those fields in the returned object, unchanged

---

### Requirement: Stage lifecycle events are recorded in events.jsonl
The orchestrator SHALL append a `stage_start` event when a stage handler is entered and a `stage_complete` event when a stage handler exits. Both event types SHALL contain at minimum: `schema_version` (integer), `type` (string: `"stage_start"` or `"stage_complete"`), `at` (ISO 8601 UTC string), and `stage` (stage name string). `stage_complete` SHALL additionally contain `outcome` (one of `"advanced"`, `"blocked"`, `"skipped"`, or `"error"`).

#### Scenario: stage_start event appended on stage entry
- **WHEN** a stage handler is entered
- **THEN** a `stage_start` event SHALL be appended to `events.jsonl`
- **AND** the event SHALL contain `schema_version`, `type: "stage_start"`, `at`, and `stage`

#### Scenario: stage_complete event appended on stage exit
- **WHEN** a stage handler exits
- **THEN** a `stage_complete` event SHALL be appended to `events.jsonl`
- **AND** the event SHALL contain `schema_version`, `type: "stage_complete"`, `at`, `stage`, and `outcome`

#### Scenario: terminal ready-to-deploy stage emits lifecycle events
- **WHEN** the run reaches the terminal `ready-to-deploy` stage (handled outside the common dispatch block)
- **THEN** a `stage_start` and a `stage_complete` event SHALL still be appended for it, so the timeline is complete through the terminal stage

#### Scenario: Pipeline Desk renders stage timeline from events.jsonl without prose
- **WHEN** a consumer reads `events.jsonl` and filters for `stage_start` and `stage_complete` events
- **THEN** it SHALL be able to reconstruct the full ordered stage timeline (entry times, exit times, outcomes)
- **AND** no terminal output or human-readable prose SHALL be required

---

### Requirement: Key run lifecycle events are recorded in events.jsonl
The orchestrator SHALL append a `run_start` event immediately after the run directory is created and a `run_complete` event at finalization. Additional events SHALL be appended for significant state changes: `pr_created` (PR opened), `pr_updated` (PR updated), `worktree_created`, `worktree_removed`, `review_verdict` (per review round), `blocker_set`, and `blocker_cleared`. Each event type SHALL carry its type-specific fields in addition to the base `schema_version`, `type`, and `at` fields.

The `review_verdict` event SHALL additionally carry a `findings` array — one record per finding enumerated by the round — and the reviewer identity for the round (`reviewer_harness`, `reviewer_model`, `self_review`). Each finding record SHALL contain `key` (the stable `findingKey`), `severity`, `title`, `body`, `confidence`, and `recommendation`, and SHALL contain `file`, `line_start`, `line_end`, `category`, and `blocking` when the finding carries them. Each finding record SHALL also carry `effective_blocking` (boolean, computed from `partitionFindings` after the active policy is applied) and `payload_fingerprint` (`findingPayloadFingerprint(finding)` — disambiguates same-key distinct findings within a round). The `findings` array and reviewer-identity fields are additive optional fields, so `schema_version` SHALL remain `1`; their text fields SHALL be screened by the write-time injection denylist and secret redaction before the line is appended.

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

### Requirement: --json-events flag streams lifecycle events to stdout
When the pipeline CLI is invoked with `--json-events`, each event appended to `events.jsonl` SHALL also be written to stdout as the same JSON line (identical content). Human-readable pipeline output SHALL continue to be written to `terminal.log` (and stderr where applicable). The `--json-events` flag SHALL NOT suppress, redirect, or modify the content written to `terminal.log`.

#### Scenario: event appears on stdout in --json-events mode
- **WHEN** the pipeline runs with `--json-events` and a stage is entered
- **THEN** the `stage_start` JSON line SHALL appear on stdout at the same time it is appended to `events.jsonl`

#### Scenario: stage-owned lifecycle events also stream to stdout
- **WHEN** the pipeline runs with `--json-events` and a stage handler emits a lifecycle event from inside the handler (`worktree_created`, `pr_created`/`pr_updated`, or `review_verdict`)
- **THEN** that event's JSON line SHALL also appear on stdout — not only `events.jsonl` — so a desktop consumer reconstructing the run from stdout does not miss it

#### Scenario: terminal.log unaffected by --json-events
- **WHEN** the pipeline runs with `--json-events`
- **THEN** `terminal.log` SHALL contain the full human-readable pipeline output
- **AND** the content of `terminal.log` SHALL be identical to what it would contain without `--json-events`

#### Scenario: --json-events mode is backward-compatible for terminal users
- **WHEN** a terminal user runs the pipeline without `--json-events`
- **THEN** no JSON lines SHALL appear on stdout
- **AND** pipeline behavior SHALL be identical to before this change

