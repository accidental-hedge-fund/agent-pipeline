## ADDED Requirements

### Requirement: In-engine ship SHALL apply ship-release-check-wait before release finish

In-engine `pipeline ship` SHALL apply living `ship-release-check-wait` before it invokes `pipeline release finish` for an unfinished release PR. The coordinator SHALL classify a `gh pr checks --json` capture into exactly one of `green`, `pending`, `rerun`, or `fail`. The requested field set SHALL include `name`, `state`, `bucket`, and `link`. The waiter SHALL NOT request a non-existent `conclusion` field. Classification SHALL be deterministic from check metadata. Classification SHALL NOT require a non-deterministic LLM.

`green` SHALL invoke finish. `pending` SHALL keep waiting inside the coordinator. Durable resume on the same `pipeline ship --milestone` argv SHALL be allowed. A one-shot throw on a pending snapshot SHALL NOT persist ship failure and SHALL NOT count as the wait. Session poll-cap expiry while still `pending` SHALL preserve `next_action: "release_finish"` without persisting ship failure so the same argv can resume. `rerun` SHALL request one bounded `gh run rerun --failed` per release-PR head SHA (budget SHALL NOT exceed two) and SHALL resume wait. `fail` SHALL persist ship failure and SHALL NOT invoke finish.

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
