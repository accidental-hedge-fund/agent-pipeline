## ADDED Requirements

### Requirement: The loop-execution evidence pointer SHALL name the real advance run store when one exists

The `pipeline/loop-execution@1` evidence pointer returned after per-item execution SHALL
set `pipeline_run_id` to Agent Pipeline's real per-item advance run-store identifier
(the directory basename under `.agent-pipeline/runs/`) when that run store was pinned or
created for the hand-off. The pointer SHALL NOT report a synthetic
`pipeline-loop-<orchestrator-run-id>-<item-id>` string as the only `pipeline_run_id` when
a real advance run store exists. When the absolute path to the advance `events.jsonl` is
known, the evidence pointer SHALL carry that path in an optional absolute events field so
orchestrators and harnesses can follow stage-level progress without re-deriving layout.
The contract SHALL remain a whole-item hand-off: it SHALL NOT expose any per-stage verb.

#### Scenario: Evidence pointer uses the real run-store id

- **WHEN** per-item execution completes and the advance run store exists at
  `.agent-pipeline/runs/<issue>-<timestamp>/`
- **THEN** the response evidence `pipeline_run_id` SHALL equal that directory's basename
- **AND** SHALL NOT be only a synthetic `pipeline-loop-…` identifier

#### Scenario: Evidence pointer includes absolute events path when known

- **WHEN** per-item execution knows the absolute filesystem path of the advance
  `events.jsonl`
- **THEN** the evidence pointer SHALL include that absolute path
- **AND** a consumer SHALL be able to open the file from the pointer alone

#### Scenario: Contract remains whole-item only

- **WHEN** the `pipeline/loop-execution@1` contract is inspected after this change
- **THEN** it SHALL still contain no operation that advances a single pipeline stage
- **AND** terminal outcomes SHALL remain exactly `ready_to_deploy`,
  `blocked_needs_human`, `failed`, and `abandoned`
