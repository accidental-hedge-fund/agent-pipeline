# loop-dispatch-advance-linkage Specification

## Purpose
TBD - created by archiving change loop-dispatch-advance-run-linkage. Update Purpose after archive.
## Requirements
### Requirement: Loop item dispatch SHALL publish real advance run-store linkage at start

The durable loop SHALL record a durable, machine-readable advance-run linkage on the
loop run's event trail (or an equivalent durable handoff field in the loop run
directory) when it dispatches an item through `pipeline/loop-execution@1` and the
per-item advance run-store identity is known **and the advance run store has been
confirmed initialized** (including when the parent pins the run id before spawn and
later observes the pinned `events.jsonl`). That record SHALL be written during the
child wait once the store is confirmed (or at exit if confirmation only lands then)
and SHALL include at least: `item_id`, the real advance `pipeline_run_id` (the basename
of `.agent-pipeline/runs/<run-id>/`), and the absolute path to that run's
`events.jsonl` when the path is known. The record SHALL NOT use a synthetic
`pipeline-loop-<loop-run-id>-<item-id>` string as the only join key when a real run
store id is known. Bare OS-level process spawn SHALL NOT be treated as proof that the
run store exists.

#### Scenario: Start linkage carries real run id and events path

- **WHEN** the loop dispatches item `623` and pins advance run id
  `623-2026-07-29T13-49-56-421Z` under the resolved repo root
- **AND** the pinned advance run store is confirmed initialized (its `events.jsonl` exists)
- **THEN** a durable loop-run record SHALL exist during the child wait (or at exit if
  confirmation only lands then) with `item_id` equal to the dispatched item,
  `pipeline_run_id` equal to `623-2026-07-29T13-49-56-421Z`, and an absolute `events`
  path ending in that run's `events.jsonl`
- **AND** that `pipeline_run_id` SHALL NOT be only a synthetic `pipeline-loop-…` string

#### Scenario: A harness discovers the advance events path from loop events alone

- **WHEN** a consumer follows only the loop run's durable event trail for an active
  dispatched item
- **THEN** it SHALL be able to obtain the absolute advance `events.jsonl` path from the
  start-linkage record without parsing terminal prose and without scanning every
  `.agent-pipeline/runs/*` directory by mtime

#### Scenario: Start linkage is omitted when no live run store is confirmed

- **WHEN** dispatch fails before any advance run-store id can be pinned or discovered
- **OR WHEN** a pin is computed but the child exits before initializing the
  advance run store (`events.jsonl` never appears)
- **THEN** the loop SHALL NOT invent an absolute events path that points at a
  non-existent directory as live proof
- **AND** the loop SHALL NOT emit start linkage that presents that path as live
- **AND** terminal failure linkage (see end-linkage requirement) SHALL still be
  recordable without a fabricated live path

---

### Requirement: Loop item dispatch SHALL publish terminal advance linkage at end

The durable loop SHALL record a durable terminal advance-run linkage on the loop run's
event trail (or equivalent durable handoff field) when a `pipeline/loop-execution@1`
dispatch returns a terminal outcome for an item. That record SHALL include at least:
`item_id`, the same real `pipeline_run_id` used for start linkage when a run store was
known, the absolute `events` path when known, and the terminal outcome
(`ready_to_deploy`, `blocked_needs_human`, `failed`, or `abandoned`). Audit SHALL be
able to join supervisor evidence and advance evidence using those fields without
guessing.

#### Scenario: Terminal linkage joins outcome to the same run id

- **WHEN** item `623` finishes dispatch with outcome `ready_to_deploy` and advance run id
  `623-2026-07-29T13-49-56-421Z`
- **THEN** a durable terminal linkage record SHALL include `item_id: "623"`,
  `pipeline_run_id: "623-2026-07-29T13-49-56-421Z"`, the absolute events path when known,
  and `outcome: "ready_to_deploy"`

#### Scenario: Failed dispatch without a live store still records terminal outcome

- **WHEN** dispatch ends without a usable advance run store (spawn/init failure)
- **THEN** a durable terminal record SHALL still carry `item_id` and a terminal outcome
  of `failed` (or the contract outcome that applies)
- **AND** it SHALL NOT claim a successful live join to a non-existent `events.jsonl`

#### Scenario: Multiple dispatch attempts keep distinct run ids

- **WHEN** the same item is dispatched more than once across cycles or recoveries, each
  with its own pinned advance run id
- **THEN** each attempt's start/end linkage pair SHALL retain its own `pipeline_run_id`
- **AND** consumers SHALL join by `(item_id, pipeline_run_id)`, not by `item_id` alone

---

### Requirement: Dispatch evidence SHALL use the real advance run-store id when a store exists

The `pipeline/loop-execution@1` response evidence pointer for a dispatched item SHALL set
`pipeline_run_id` to the real advance run-store directory basename when that store was
pinned or created for the dispatch. A synthetic `pipeline-loop-…` identifier SHALL NOT be
the only join key returned in that case. When the absolute `events.jsonl` path is known,
the evidence pointer SHALL include it (or an equivalent absolute events field) so terminal
consumers need not re-derive the layout.

#### Scenario: Evidence pipeline_run_id matches the run directory basename

- **WHEN** the real dispatch seam completes for an item whose advance run directory is
  `.agent-pipeline/runs/623-2026-07-29T13-49-56-421Z/`
- **THEN** the response `evidence.pipeline_run_id` SHALL equal
  `623-2026-07-29T13-49-56-421Z`
- **AND** SHALL NOT equal only `pipeline-loop-<loop-run-id>-623`

#### Scenario: Evidence carries absolute events path when known

- **WHEN** the real dispatch seam knows the absolute path to the advance `events.jsonl`
- **THEN** the response evidence SHALL include that absolute path in a dedicated field
- **AND** a consumer SHALL be able to open stage-level events from that field alone

#### Scenario: Synthetic id is last-resort only

- **WHEN** no advance run store can be pinned or created for the dispatch
- **THEN** the response MAY use a synthetic fallback identifier for traceability
- **AND** unit tests for the store-exists path SHALL fail if only the synthetic form is
  returned

---

### Requirement: Unit tests SHALL cover start and end linkage via injected seams

The implementation SHALL provide unit tests that inject dispatch and run-store seams (no
real network, git, or subprocess) and cover: start linkage when a run store id is known;
terminal linkage with outcome and the same ids; truthful `pipeline_run_id` on the evidence
pointer when a store exists; and rejection of synthetic-only join keys in the store-exists
case. At least one regression SHALL fail against synthetic-only evidence behavior without
the fix.

#### Scenario: Injected dispatch proves start and end linkage

- **WHEN** a unit test drives the supervisor or dispatch helpers with a fake that reports
  a known advance run id and events path
- **THEN** the recorded start linkage and terminal linkage SHALL both carry that run id
  and item id, and the terminal record SHALL carry the outcome

#### Scenario: Regression bites synthetic-only evidence

- **WHEN** the production evidence builder is exercised for a dispatch with a known run
  store without the fix applied
- **THEN** a regression assertion that requires `evidence.pipeline_run_id` to equal the
  real store id SHALL fail

### Requirement: Active advance linkage SHALL enable pre-merge progress join keys

The loop SHALL use the `item_id`, `pipeline_run_id`, and absolute `events` path
from `loop_item_advance_linked` as the join keys for subsequent material
pre-merge progress events for that dispatch attempt. Consumers SHALL be able to
correlate progress lines to the same advance run store as the start linkage
without scanning unrelated runs. Progress emission requirements live in the
`loop-pre-merge-gate-sub-events` capability; this requirement only binds
join-key continuity.

#### Scenario: Progress uses the same pipeline_run_id as start linkage

- **WHEN** start linkage for item `554` publishes `pipeline_run_id`
  `554-2026-07-29T17-23-40-332Z` and absolute `events` path `E`
- **AND** a material pre-merge progress event is later appended for that
  dispatch attempt
- **THEN** that progress event SHALL carry `item_id` equal to `554` and
  `pipeline_run_id` equal to `554-2026-07-29T17-23-40-332Z`
- **AND** SHALL include absolute events path `E` when path inclusion is
  supported by the progress payload

#### Scenario: Distinct dispatch attempts keep distinct join keys

- **WHEN** the same item is dispatched twice with two different advance run ids
- **THEN** progress events for each attempt SHALL use that attempt’s own
  `pipeline_run_id`
- **AND** consumers SHALL join by `(item_id, pipeline_run_id)`, not by
  `item_id` alone

### Requirement: Stage-progress surfaces SHALL prefer the real advance run-store id from linkage

When a per-item stage-progress projection, audit stage table row, or stage-progress follow event includes an advance run identifier, that identifier SHALL be the real advance run-store directory basename published by start/terminal linkage (the basename of `.agent-pipeline/runs/<run-id>/`) whenever that real id is known. A synthetic `pipeline-loop-<loop-run-id>-<item-id>` string SHALL NOT be the only advance run id presented on those surfaces when a real run store id is known. When no real advance run id is known, the surface SHALL omit the drill-down id or mark it absent rather than inventing a live path.

#### Scenario: Audit drill-down uses the linked real run id

- **WHEN** start linkage for item `607` recorded `pipeline_run_id` `607-2026-07-27T19-31-29-328Z`
- **AND** the stage-progress audit table includes item `607`
- **THEN** the advance run id shown for drill-down SHALL equal `607-2026-07-27T19-31-29-328Z`
- **AND** SHALL NOT equal only a synthetic `pipeline-loop-…` string

#### Scenario: Follow event carries the same real run id

- **WHEN** a structured stage-progress event is emitted for an item with known real advance run id `607-2026-07-27T19-31-29-328Z`
- **THEN** that event's advance run id field SHALL equal `607-2026-07-27T19-31-29-328Z`

#### Scenario: Unknown linkage omits fabricated drill-down

- **WHEN** an item has never had a confirmed advance run store for the current attempt
- **THEN** stage-progress surfaces SHALL NOT present a fabricated path under `.agent-pipeline/runs/` as a live follow target for that item

