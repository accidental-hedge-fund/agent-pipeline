## ADDED Requirements

### Requirement: In-engine ship SHALL apply ship-release-check-wait before release finish

In-engine `pipeline ship` SHALL apply living `ship-release-check-wait` before it invokes `pipeline release finish` for an unfinished release PR. The coordinator SHALL classify a `gh pr checks --json` capture into exactly one of `green`, `pending`, `rerun`, or `fail`. The requested field set SHALL include `name`, `state`, `bucket`, and `link`. The waiter SHALL NOT request a non-existent `conclusion` field. Classification SHALL be deterministic from check metadata. Classification SHALL NOT require a non-deterministic LLM.

`green` SHALL invoke finish. `pending` SHALL keep waiting inside the coordinator. Durable resume on the same `pipeline ship --milestone` argv SHALL be allowed. A one-shot throw on a pending snapshot SHALL NOT persist ship failure and SHALL NOT count as the wait. Session poll-cap expiry while still `pending` SHALL preserve `next_action: "release_finish"` without persisting ship failure so the same argv can resume. `rerun` SHALL request one bounded `gh run rerun --failed` per release-PR head SHA (budget SHALL NOT exceed two) and SHALL resume wait. `fail` SHALL persist ship failure and SHALL NOT invoke finish.

The coordinator SHALL re-observe the release PR identity after each wait capture and immediately before finish. When the live PR or head SHA differs from the prepared identity, the coordinator SHALL NOT rerun workflows and SHALL NOT invoke finish under the stale checkpoint. It SHALL stop resumably so the same argv can recover. Persisted rerun-budget state SHALL be written atomically. When an existing budget file cannot be parsed, the waiter SHALL treat the budget as exhausted and SHALL NOT issue an additional rerun.

The finish-converge path (`convergeReleaseFinish` or the seam it calls) SHALL NOT invoke finish while the waiter would classify `pending` or `rerun`. When an already-merged finish identity is observed for the same PR and head, the coordinator SHALL reuse that evidence and SHALL NOT wait or finish again. This requirement does not turn bare `pipeline release finish` into a poller.

#### Scenario: Pending checks do not invoke finish

- **WHEN** in-engine `pipeline ship` reaches release finish for an open release PR
- **AND** the waiter classifies the current checks capture as `pending`
- **THEN** the coordinator SHALL keep waiting
- **AND** it SHALL NOT invoke `pipeline release finish` for that PR on that poll
- **AND** it SHALL NOT persist ship failure solely because that snapshot was pending

#### Scenario: Pending wait-cap expiry stays resumable

- **WHEN** in-engine `pipeline ship` is waiting on an open release PR
- **AND** the session poll cap expires while the waiter still classifies `pending`
- **THEN** the coordinator SHALL preserve `next_action: "release_finish"`
- **AND** it SHALL NOT persist ship failure
- **AND** a same-argv retry SHALL resume the wait

#### Scenario: Green after wait invokes finish

- **WHEN** a later poll classifies the same open release PR as `green`
- **THEN** the coordinator SHALL invoke `pipeline release finish` for that PR
- **AND** it SHALL NOT open a second release PR for that version

#### Scenario: Flake-eligible test fail reruns then waits

- **WHEN** the only settled failed check is named `test`
- **AND** no other check is pending
- **AND** rerun budget remains for that head SHA
- **THEN** the coordinator SHALL request `gh run rerun --failed` for that run id
- **AND** it SHALL resume waiting
- **AND** it SHALL NOT invoke finish on that poll

#### Scenario: Terminal fail does not invoke finish

- **WHEN** the waiter classifies the capture as `fail`
- **THEN** the coordinator SHALL persist ship failure
- **AND** it SHALL NOT invoke `pipeline release finish`

#### Scenario: Already-finished observation skips the wait

- **WHEN** the coordinator re-observes a merged finish identity for the prepared release PR and head
- **THEN** it SHALL reuse that finish evidence
- **AND** it SHALL NOT wait on checks
- **AND** it SHALL NOT merge again

#### Scenario: Regression fails if finish is invoked on pending

- **WHEN** an automated check drives the finish-converge seam with a checks capture the waiter would classify as `pending`
- **THEN** the decision SHALL be wait, not finish
- **AND** the check SHALL fail if finish is invoked on that capture

#### Scenario: Head change during wait does not finish or rerun

- **WHEN** in-engine `pipeline ship` is waiting on an open release PR
- **AND** a later poll observes a different release-PR head than the prepared identity
- **THEN** the coordinator SHALL NOT request `gh run rerun --failed` under the stale head
- **AND** it SHALL NOT invoke `pipeline release finish` for the stale identity
- **AND** it SHALL stop resumably without persisting ship failure

#### Scenario: Unreadable rerun-budget state does not reset the cap

- **WHEN** persisted rerun-budget state for a release-PR head cannot be parsed
- **AND** a later capture is rerun-eligible
- **THEN** the coordinator SHALL treat the budget as exhausted
- **AND** it SHALL NOT request an additional `gh run rerun --failed`
