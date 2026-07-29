## ADDED Requirements

### Requirement: The supervisor SHALL record durable advance-run linkage for each dispatched item

The supervisor SHALL append a durable start-linkage event (or equivalent durable handoff
field in the authoritative loop run directory) when it dispatches an item through
`pipeline/loop-execution@1` and the per-item advance run-store identity is known, carrying
at least `item_id`, the real advance `pipeline_run_id`, and the absolute advance
`events.jsonl` path when known. The supervisor SHALL append a durable terminal-linkage
event when the dispatch returns a terminal outcome, carrying the same `item_id` and real
`pipeline_run_id` (and events path when known) plus the terminal outcome. These records
SHALL be written through the store's injectable seam so unit tests drive them with no
real process, network, or git call. The supervisor SHALL continue to hand off whole items
only and SHALL NOT own pipeline stage labels or merge.

#### Scenario: Start linkage is durable on the loop run

- **WHEN** the supervisor dispatches an item whose advance run-store id is known
- **THEN** the loop run's durable event trail SHALL contain a start-linkage record with
  that item's id, the real advance `pipeline_run_id`, and the absolute events path when
  known
- **AND** the record SHALL be readable after a supervisor process restart from the same
  run directory

#### Scenario: Terminal linkage includes outcome

- **WHEN** the dispatch for that item returns a contract terminal outcome
- **THEN** the loop run's durable event trail SHALL contain a terminal-linkage record with
  the same item and advance run ids and that outcome
- **AND** audit SHALL be able to join the supervisor trail to
  `.agent-pipeline/runs/<pipeline_run_id>/events.jsonl` using those fields

#### Scenario: Coarse item events are not the only join surface

- **WHEN** a harness follows only supervisor events for an in-flight item
- **THEN** it SHALL obtain the advance run join key from the start-linkage record rather
  than inferring it from `loop_item_started` alone or from a synthetic
  `pipeline-loop-…` evidence id

#### Scenario: Linkage writes use the injectable store seam

- **WHEN** a unit test injects a fake store and a fake dispatch that reports a known
  advance run id
- **THEN** the start and terminal linkage records SHALL appear via that seam without a
  real subprocess or filesystem run store
