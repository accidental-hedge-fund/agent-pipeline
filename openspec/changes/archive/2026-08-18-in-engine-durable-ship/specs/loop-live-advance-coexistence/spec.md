## ADDED Requirements

### Requirement: A dead prior holder SHALL be takeover of the same item

When the live-advance or coexistence probe observes a recorded holder whose process is dead, whose lock is stale, or whose loop/run directory is a corpse (no live PID and no verifiable live wrapper identity), the supervisor SHALL treat that item as not live. It SHALL take over the same item and resume from the last durable stage (worktree + labels + ledger). It SHALL NOT record `coexistence_wait` for that dead holder. It SHALL NOT wait until a no-progress watchdog fires. A **live** holder (live lock or live wrapper/process identity for the same domain and issue) SHALL remain a non-fatal coexistence wait.

#### Scenario: Dead lock after SIGTERM is takeover

- **WHEN** issue N is `pipeline:implementing`
- **AND** the recorded issue-run lock or wrapper PID is dead
- **AND** no live process identity exists for `(domain, N)`
- **THEN** the supervisor SHALL take over issue N and resume
- **AND** it SHALL NOT record `coexistence_wait` for that dead holder
- **AND** it SHALL NOT STOP the run with `supervisor_no_progress` solely for that evidence

#### Scenario: Six waits on a corpse fail the fixture

- **WHEN** a fixture replays a killed implementer, a recovered dead lock, and a reused loop run id whose holder is dead
- **THEN** the supervisor SHALL take over the same item on the first cycle that observes the dead holder
- **AND** the fixture SHALL fail if the run records two or more `coexistence_wait` outcomes for that corpse
- **AND** the fixture SHALL fail if the run stops with `supervisor_no_progress`

#### Scenario: Live holder still waits

- **WHEN** the probe reports a live lock or live wrapper identity for issue N under its domain
- **THEN** the supervisor SHALL keep the existing non-fatal coexistence wait
- **AND** it SHALL NOT start a second full advance for issue N
