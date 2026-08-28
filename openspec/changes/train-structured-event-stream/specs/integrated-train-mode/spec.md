## MODIFIED Requirements

### Requirement: Train status and events SHALL be machine-readable for supervisors

The train SHALL expose a status read model (CLI status and/or JSON events) that includes train identity, ordered issue list, current issue, current stage or item state, linked PR when known, last merge-result identity when known, next action, and blocker if stopped. Train identity SHALL include the durable train-level run ID published by the `train-event-stream` capability. Mid-flight supervisors SHALL read that run's generic `events.jsonl` (via `pipeline logs <train-run-id> --events`) rather than scraping unstructured train stdout. Notification failure by an external supervisor SHALL NOT change train or Pipeline state.

#### Scenario: Status names the current item and next action

- **WHEN** an operator or supervisor requests train status during an active train
- **THEN** the status SHALL include the current issue number and the next deterministic action (advance, merge, wait-for-base, complete, or stopped)

#### Scenario: Events do not authorize mutations

- **WHEN** train events are streamed to a notifier
- **THEN** those events SHALL be observational only
- **AND** they SHALL NOT grant merge or advance authority

#### Scenario: Status and events name the train run ID

- **WHEN** a train run store has been initialized
- **THEN** train status SHALL include that train `run_id`
- **AND** a supervisor SHALL be able to follow `.agent-pipeline/runs/<run_id>/events.jsonl` with `pipeline logs <run_id> --events`

### Requirement: Train JSON mode SHALL emit one final object on stdout

When `pipeline train` is invoked with `--json`, stdout SHALL contain exactly one
unfenced JSON object whose `kind` is `train_status`. That object SHALL include
an additive `run_id` field set to the durable train-level run ID when the train
run store was initialized (`schema_version` remains `1`). Nested `single` runs
SHALL NOT write handoff, status, or terminal JSON objects to that stdout stream.
`train_run_handoff` and train `events.jsonl` lines SHALL NOT appear on that
stdout stream. Human diagnostics, `train_run_handoff`, and child progress MAY
use stderr or the existing run event streams.

#### Scenario: Successful train output parses once

- **WHEN** a train advances two issues successfully with `--json`
- **THEN** one `JSON.parse` of the complete stdout SHALL return the final
  `train_status` object
- **AND** no child-run JSON SHALL precede or follow that object

#### Scenario: Child progress remains observable

- **WHEN** a child issue run emits handoff or stage progress during a JSON train
- **THEN** that progress SHALL remain available through stderr and/or the exact
  child run's events
- **AND** it SHALL NOT corrupt the final train JSON object

#### Scenario: train_status carries run_id

- **WHEN** a JSON train initializes a train run store with id `train-2026-08-28T17-28-03-000Z`
- **THEN** the stdout `train_status` object SHALL include `run_id` equal to
  `train-2026-08-28T17-28-03-000Z`
- **AND** `schema_version` SHALL remain `1`
