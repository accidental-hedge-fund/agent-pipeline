# loop-needs-human-blocker-disposition Specification

## Purpose
TBD - created by archiving change loop-needs-human-blocker-disposition. Update Purpose after archive.
## Requirements
### Requirement: A needs-human pipeline blocker SHALL be recorded as a non-terminal hold, never as a run-fatal engine defect

The supervisor SHALL treat a per-item pipeline blocker whose disposition is "needs human
answer / unblock" — observed as the dispatched item carrying `pipeline:blocked` on live
truth — as a non-terminal **needs-human hold**. When per-item execution reports
`blocked_needs_human`, or reports a `failed` outcome whose live issue is nonetheless
observed at `pipeline:blocked` (a recoverable, human-unblockable disposition) without a
crashed or rejected dispatch, the supervisor SHALL move the item into a `paused`/`waiting`
hold so the run reports `hold_outstanding=true` and pauses. Such an outcome SHALL NEVER be
classified under the `workflow-engine-defect` blocker class and SHALL NEVER record a
`run_fatal` or `human_authority` run stop. Every sibling item's state — including an item
already at `ready` — SHALL be preserved across the hold. A genuine engine defect — a
rejected or crashed dispatch, or an unrecognized terminal outcome with the item at no
`pipeline:blocked` state — SHALL remain classified `workflow-engine-defect` with its
`run_fatal` policy unchanged. The disposition SHALL be a deterministic function of the
observed live labels so a unit test drives it with no real network, git, or subprocess
call.

#### Scenario: A plan-review format blocker becomes a needs-human hold

- **WHEN** an item's dispatch reports "blocked at plan-review: `Plan revision output is
  missing required ## Feedback Incorporated section`" and the item is observed carrying
  `pipeline:blocked`
- **THEN** the supervisor SHALL move the item into a `paused`/`waiting` hold and report
  `hold_outstanding=true`
- **AND** it SHALL NOT classify the item under `workflow-engine-defect`
- **AND** it SHALL NOT record a `run_fatal` or `human_authority` run stop

#### Scenario: A direct blocked_needs_human outcome holds rather than stops

- **WHEN** per-item execution reports the terminal outcome `blocked_needs_human`
- **THEN** the supervisor SHALL record a non-terminal needs-human hold with
  `hold_outstanding=true`
- **AND** it SHALL NOT record a terminal `human_authority` or `run_fatal` run stop for that
  outcome

#### Scenario: A failed outcome observed at pipeline:blocked is routed to the hold

- **WHEN** an item's dispatch outcome normalizes to `failed`, the dispatch did not crash or
  reject, and the item is observed on live truth carrying `pipeline:blocked`
- **THEN** the supervisor SHALL treat it as a needs-human hold with `hold_outstanding=true`
- **AND** it SHALL NOT classify the item under `workflow-engine-defect` and SHALL NOT record
  a `run_fatal` run stop

#### Scenario: A genuine engine defect is still run-fatal

- **WHEN** a dispatch is rejected or crashes, or reports an outcome outside the defined
  terminal set with the item at no `pipeline:blocked` state
- **THEN** the outcome SHALL be classified `workflow-engine-defect`
- **AND** its existing `run_fatal` policy SHALL apply unchanged

#### Scenario: A ready sibling survives a needs-human hold

- **WHEN** a run holds one item for a needs-human pipeline blocker while a sibling item is
  at `ready`
- **THEN** the run SHALL pause with `hold_outstanding=true` rather than record a terminal
  stop
- **AND** the `ready` sibling's state SHALL be preserved unchanged

---

### Requirement: A terminal run stop SHALL disclose every outstanding ready-to-deploy item

A terminal run stop SHALL enumerate every outstanding `ready` item. When the supervisor
records any terminal run stop while one or more items are in the `ready` state
(`pipeline:ready-to-deploy`, awaiting the human merge the pipeline never performs), the
durable stop record SHALL enumerate the ids of those outstanding `ready` items, and the
`pipeline loop` command output SHALL name them. A stop SHALL NEVER be
recorded or reported in a way that silently discards an outstanding ready-to-deploy hold.
The disclosure SHALL be additive metadata on the stop — it SHALL NOT introduce a new
terminal condition, alter the stop reason, or change which items are considered done. When
no item is in the `ready` state at stop time, the enumerated set SHALL be empty and the
existing stop output SHALL be otherwise unchanged.

#### Scenario: A stop names the stranded ready item

- **WHEN** the supervisor records a terminal stop while one item is at `ready` and another
  item caused the stop
- **THEN** the durable stop record SHALL enumerate the `ready` item's id as outstanding
- **AND** the `pipeline loop` output SHALL name that `ready` item

#### Scenario: A stop with no ready item discloses an empty set

- **WHEN** the supervisor records a terminal stop while no item is at `ready`
- **THEN** the stop record's outstanding-ready set SHALL be empty
- **AND** the stop reason and the rest of the stop output SHALL be unchanged from the
  pre-change behavior

#### Scenario: Disclosure does not change the terminal condition

- **WHEN** a stop is recorded alongside one or more outstanding `ready` items
- **THEN** the stop reason and the run's terminal condition SHALL be exactly what they would
  have been without the disclosure
- **AND** the outstanding-ready enumeration SHALL be the only added information

