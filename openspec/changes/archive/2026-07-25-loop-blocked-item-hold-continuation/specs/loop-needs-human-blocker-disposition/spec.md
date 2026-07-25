## MODIFIED Requirements

### Requirement: A needs-human pipeline blocker SHALL be recorded as a non-terminal hold, never as a run-fatal engine defect

The supervisor SHALL treat a per-item pipeline blocker whose disposition is "needs human
answer / unblock" — observed as the dispatched item carrying `pipeline:blocked` on live
truth — as a non-terminal **needs-human hold**. Detection of the `pipeline:blocked`
disposition SHALL use the **presence** of that label in the item's observed live label set,
independent of any co-present `pipeline:*` stage label and independent of the single-winner
stage value derived for the item. When per-item execution reports `blocked_needs_human`, or
reports a `failed` outcome whose live issue is nonetheless observed carrying `pipeline:blocked`
(a recoverable, human-unblockable disposition — including a stale or reason-less blocker, and
including one co-present with a stage label) without a crashed or rejected dispatch, the
supervisor SHALL move the item into a `paused`/`waiting` hold so the run reports
`hold_outstanding=true` and holds that item. The run SHALL pause on that hold only when no
other item can make progress; while at least one other item is schedulable the run SHALL
continue with the remaining schedulable items and re-evaluate the held item each cycle (per
`loop-blocked-item-hold-continuation`). Such an outcome SHALL NEVER be classified under the
`workflow-engine-defect` blocker class and SHALL NEVER record a `run_fatal` or
`human_authority` run stop. Every sibling item's state — including an item already at `ready`
— SHALL be preserved across the hold. A genuine engine defect — a rejected or crashed
dispatch, or an unrecognized terminal outcome with the item at no `pipeline:blocked` state —
SHALL remain classified `workflow-engine-defect` with its `run_fatal` policy unchanged. The
disposition SHALL be a deterministic function of the observed live labels so a unit test
drives it with no real network, git, or subprocess call.

#### Scenario: A plan-review format blocker becomes a needs-human hold

- **WHEN** an item's dispatch reports "blocked at plan-review: `Plan revision output is
  missing required ## Feedback Incorporated section`" and the item is observed carrying
  `pipeline:blocked`
- **THEN** the supervisor SHALL move the item into a `paused`/`waiting` hold and report
  `hold_outstanding=true`
- **AND** it SHALL NOT classify the item under `workflow-engine-defect`
- **AND** it SHALL NOT record a `run_fatal` or `human_authority` run stop

#### Scenario: A blocked label co-present with a stage label is still detected

- **WHEN** an item's dispatch outcome normalizes to `failed`, the dispatch did not crash or
  reject, and the item is observed carrying `pipeline:blocked` co-present with another
  `pipeline:*` stage label
- **THEN** the supervisor SHALL detect the `pipeline:blocked` disposition from the label's
  presence and move the item into a needs-human hold
- **AND** it SHALL NOT fall through to `workflow-engine-defect` because another label was the
  single stage-winner

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
  at `ready` and no other item is schedulable
- **THEN** the run SHALL pause with `hold_outstanding=true` rather than record a terminal
  stop
- **AND** the `ready` sibling's state SHALL be preserved unchanged

#### Scenario: A hold with a schedulable sibling continues the run

- **WHEN** a run holds one item for a needs-human pipeline blocker while a sibling item is
  still schedulable
- **THEN** the run SHALL continue dispatching the schedulable sibling rather than pausing
- **AND** the held item SHALL be re-evaluated each cycle and remain a non-terminal hold
