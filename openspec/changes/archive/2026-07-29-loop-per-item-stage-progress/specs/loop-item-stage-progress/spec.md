## ADDED Requirements

### Requirement: The durable loop SHALL record a per-item current-stage signal distinct from coarse item state

The durable loop run SHALL maintain a first-class per-item **current-stage** projection for each selector item. That projection SHALL include at least the item's current pipeline stage name (the `pipeline:*` stage the item is in, or the advance stage identifier used by the child run store) and, when applicable, the active review or fix round. The projection SHALL be stored on the item's durable ledger entry (or an equivalent durable per-item field under the same loop run directory) and SHALL be distinct from the item's coarse ledger `state` (`pending`, `in_progress`, `blocked`, `ready`, and other closed item states). Coarse `state` alone SHALL NOT be treated as satisfying this requirement. Recording the projection SHALL NOT write GitHub `pipeline:*` labels and SHALL NOT merge or release any pull request.

#### Scenario: In-progress item carries a stage beyond coarse state

- **WHEN** item `607` is mid-advance with coarse ledger `state` equal to `in_progress`
- **AND** the child advance has started stage `implementing`
- **THEN** the durable per-item current-stage projection for `607` SHALL report stage `implementing` (or an equivalent stage name for that transition)
- **AND** the item's coarse `state` SHALL remain a closed ledger item state such as `in_progress`
- **AND** the two fields SHALL both be readable from the loop run's durable artifacts

#### Scenario: Review or fix round is recorded when applicable

- **WHEN** item `607` is in a review stage at review round `1`
- **THEN** the durable current-stage projection SHALL include that round (as a dedicated field or an unambiguous combined presentation backed by durable data)
- **AND** a later transition to review round `2` SHALL update the recorded round

#### Scenario: Stage projection does not own labels or merge

- **WHEN** the loop records or updates a per-item current-stage projection
- **THEN** it SHALL NOT write a GitHub `pipeline:*` stage label as part of that record
- **AND** it SHALL NOT merge, enable auto-merge, or otherwise release the item's pull request

---

### Requirement: The current-stage signal SHALL update on stage transition during advance

While an item is being advanced, the durable loop SHALL update that item's current-stage projection when the item transitions pipeline stages (including transitions observed via the linked advance run store's stage events). Updates SHALL occur during the mid-advance window, not only at dispatch start or terminal outcome. When no material stage or round change has occurred, the loop MAY omit a redundant write. When the linked advance run store is not yet confirmed, the loop SHALL NOT invent a live stage path or advance run-id as if the store were ready.

#### Scenario: Stage transition mid-advance updates the durable projection

- **WHEN** item `607` is mid-advance and its recorded stage is `planning`
- **AND** the linked advance run records a transition to stage `implementing`
- **THEN** the durable current-stage projection for `607` SHALL update to `implementing`
- **AND** the update SHALL be present before the item's terminal dispatch outcome is recorded

#### Scenario: No fabricated stage while advance store is unconfirmed

- **WHEN** dispatch has pinned an intended advance run id but the advance `events.jsonl` is not yet confirmed
- **THEN** the loop SHALL NOT present a fabricated live stage timeline as if the store were ready
- **AND** once the store is confirmed and stage events appear, the projection SHALL begin updating from those events

#### Scenario: Terminal outcome remains reconcilable with coarse state

- **WHEN** the item reaches a terminal dispatch outcome such as `ready_to_deploy` or `blocked_needs_human`
- **THEN** the coarse ledger `state` SHALL continue to follow existing terminal mapping rules
- **AND** the current-stage projection SHALL either reflect a terminal stage presentation consistent with that outcome or retain the last observed stage without clearing coarse `state`

---

### Requirement: Structured loop events SHALL record stage transitions for whole-run follow

On each material current-stage update for an item, the durable loop SHALL append a structured event to the loop run's append-only event log carrying at least: `item_id`, the new stage name, the round when applicable, a timestamp, and the real advance `pipeline_run_id` when known. That event stream SHALL be sufficient for a read-only follower to render clean one-line stage-progress lines for the whole run without reading per-item harness `terminal.log` or interleaved harness prose.

#### Scenario: Material stage change appends a structured loop event

- **WHEN** item `607`'s current-stage projection changes from `planning` to `implementing` with advance run id `607-2026-07-27T19-31-29-328Z`
- **THEN** the loop run's `events.jsonl` SHALL append a structured stage-progress event including `item_id: "607"`, stage `implementing`, and advance run id `607-2026-07-27T19-31-29-328Z`

#### Scenario: Follower does not need harness stdout

- **WHEN** a consumer follows only the loop run's structured stage-progress events
- **THEN** it SHALL be able to list each item's latest stage transition for the run
- **AND** it SHALL NOT need to parse per-item harness `terminal.log` prose to obtain that stage list

---

### Requirement: Audit SHALL render a per-item stage table with advance run-id drill-down

`pipeline loop --audit` (targeting an existing durable loop run) SHALL render a per-item stage table derived from durable run artifacts. For each item in the run the table SHALL include: the item id, a current-stage presentation (or a clear queued/pending presentation when not mid-advance), and the item's advance run-id when known. The table SHALL make it possible to pass a known advance run-id to `pipeline logs <advance-run-id> --follow` without scanning `.agent-pipeline/runs/*` by mtime and without grepping harness stdout. Audit SHALL remain read-only: no ledger write, no lock acquisition, no process-identity write, and no GitHub mutation.

#### Scenario: Audit shows in-flight stage and advance run id

- **WHEN** `--audit` is invoked for a run where item `607` is at stage `implementing` with advance run id `607-2026-07-27T19-31-29-328Z`
- **THEN** the audit output SHALL include a row (or equivalent structured section) naming `#607` (or `607`), stage `implementing`, and advance run id `607-2026-07-27T19-31-29-328Z`

#### Scenario: Audit shows queued items without inventing an advance run

- **WHEN** `--audit` is invoked for a run where item `608` is still `pending` and has no live advance run
- **THEN** the audit stage table SHALL present `608` as pending/queued (or equivalent)
- **AND** SHALL NOT invent a live advance run-id for `608`

#### Scenario: Audit remains read-only while printing the stage table

- **WHEN** `--audit` prints the per-item stage table
- **THEN** through injected seams it SHALL record no ledger write, no lock acquisition, no process-identity write, and no GitHub mutation

---

### Requirement: A documented follow mode SHALL stream whole-run stage transitions as clean one-line events

The CLI SHALL provide at least one documented observation path that streams whole-run stage-transition progress for a durable loop run as clean, one-line, structured (or structured-rendered) events. Acceptable shapes include `pipeline loop --audit --follow` and/or `pipeline loop --resume <run-id> --follow` when defined as observation, provided the path is documented and unambiguous. The stream SHALL include item id, stage (and round when applicable), and advance run-id when known. The stream SHALL NOT re-emit interleaved per-item harness stdout/terminal prose as its primary content. The follower process SHALL be read-only: it SHALL NOT acquire the durable loop store lock, SHALL NOT write the ledger or process-identity record, SHALL NOT mutate GitHub, and SHALL NOT hold a `pipeline-starting-*.lock` (or other run-liveness reservation).

#### Scenario: Follow streams a stage transition line

- **WHEN** the documented stage-progress follow path is attached to an existing run
- **AND** item `607` transitions to stage `implementing` with a known advance run id
- **THEN** the follower SHALL emit a single clean progress line (or JSON event line) that includes item `607`, stage `implementing`, and that advance run id
- **AND** that line SHALL NOT be a dump of harness stream-of-consciousness stdout

#### Scenario: Follow works without the supervisor process being specially instrumented beyond durable events

- **WHEN** the supervisor has appended structured stage-progress events to the loop run's event log
- **AND** the follow path is invoked
- **THEN** the follower SHALL obtain new transitions from durable artifacts (loop events and/or ledger projection updates) rather than from a side-channel that only exists inside the live process memory

#### Scenario: Follower holds no run-liveness lock

- **WHEN** the stage-progress follow path is running
- **THEN** no `pipeline-starting-<pid>.lock` (or equivalent run-liveness reservation) SHALL exist on the follower's behalf
- **AND** the follower SHALL perform no durable ledger write

---

### Requirement: Unit tests SHALL cover stage projection, audit table, and follow formatting via injected seams

The implementation SHALL provide unit tests that inject store and advance-event seams (no real network, git, or live supervisor subprocess) and cover: (1) current-stage recorded and updated on a stage transition while coarse `state` stays a closed item state; (2) audit stage table includes stage and advance run-id when known; (3) follow/format helpers emit structured stage lines without harness stdout; (4) absence of stage data degrades without inventing live advance paths. At least one regression SHALL fail against an audit report surface that omits per-item stage while an in-flight item only has coarse `in_progress` state.

#### Scenario: Injected advance events update projection

- **WHEN** a unit test feeds a fake advance event stream with `stage_start` for `implementing`
- **THEN** the durable projection update path SHALL record stage `implementing` for that item without a real child process

#### Scenario: Regression bites audit without stage table

- **WHEN** the audit renderer is exercised against a run with an in-flight item that has a recorded current-stage and advance run-id
- **AND** the fix that renders the stage table is absent
- **THEN** a regression assertion that requires the stage name and advance run-id in audit output SHALL fail
