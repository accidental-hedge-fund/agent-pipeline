## ADDED Requirements

### Requirement: Exact-run ship observers SHALL exit on bound-stream identity-terminal

An exact-run ship progress observer bound to one `events.jsonl` SHALL treat identity-terminal events of that bound stream as end-of-follow. For a loop events file, those kinds SHALL be `loop_run_superseded`, `loop_run_complete`, and `loop_run_stopped`. For a ship events file, `ship_phase` with phase `complete` and status `completed` SHALL remain a terminal. The observer SHALL emit the material line for the identity-terminal event it observes, then SHALL exit. The observer SHALL NOT remain alive waiting for a terminal kind that the bound file cannot produce. A loop follow SHALL NOT use `ship_phase` complete as its only stop. The observer SHALL still require one absolute `--events-file` (or equivalent exact path). The observer SHALL NOT glob host-global run directories, pick the newest `events.jsonl` by mtime, or reconstruct a successor path from `superseded_by`.

#### Scenario: loop_run_superseded ends follow

- **WHEN** bundled `ship-stage-watch` follow mode is bound to one absolute loop `events.jsonl`
- **AND** that file receives a `loop_run_superseded` event
- **THEN** the observer SHALL emit the material line for that event
- **AND** the observer process SHALL exit
- **AND** it SHALL NOT keep following that file

#### Scenario: loop_run_complete ends follow of a superseded or finished run

- **WHEN** bundled `ship-stage-watch` follow mode is bound to one absolute loop `events.jsonl`
- **AND** that file receives a `loop_run_complete` event
- **THEN** the observer SHALL emit the material line for that event
- **AND** the observer process SHALL exit

#### Scenario: loop_run_stopped ends follow

- **WHEN** bundled `ship-stage-watch` follow mode is bound to one absolute loop `events.jsonl`
- **AND** that file receives a `loop_run_stopped` event
- **THEN** the observer SHALL emit the material line for that event
- **AND** the observer process SHALL exit

#### Scenario: ship_phase complete still ends a ship-stream follow

- **WHEN** the observer is bound to a ship events file
- **AND** that file receives `ship_phase` with phase `complete` and status `completed`
- **THEN** the observer SHALL emit the material line for that event
- **AND** the observer process SHALL exit

#### Scenario: Follow does not discover a successor run

- **WHEN** the bound loop file records `loop_run_superseded` with a `superseded_by` run id
- **THEN** the observer SHALL exit rather than open another `events.jsonl`
- **AND** it SHALL NOT search host-global run directories for the successor

### Requirement: Exact-run ship observers SHALL exit after bounded inactivity on a terminal bound file

An exact-run ship progress observer SHALL exit when the bound file has already produced an identity-terminal event (or has been classified terminal) and no new parsed event arrives within a documented inactivity bound. That bound SHALL be overridable in tests. The observer SHALL NOT apply that inactivity exit to a live bound file that has not produced identity-terminal. Silent follow of a superseded or completed file SHALL NOT be the product path.

#### Scenario: Idle after supersede forces exit

- **WHEN** follow mode has observed `loop_run_superseded` on the bound file
- **AND** no further parsed event arrives within the documented inactivity bound
- **THEN** the observer process SHALL exit
- **AND** it SHALL NOT remain blocked on `tail -F` of that silent file

#### Scenario: Idle does not kill a live quiet run

- **WHEN** follow mode is bound to a live loop file that has not emitted `loop_run_superseded`, `loop_run_complete`, or `loop_run_stopped`
- **AND** no new event arrives for longer than the inactivity bound
- **THEN** the observer SHALL keep following
- **AND** it SHALL NOT exit solely because the live run is quiet

### Requirement: Bound-stream identity-terminal follow-exit SHALL be regression-tested

Automated checks SHALL fail if bundled `ship-stage-watch` follow mode is given an events stream that includes `loop_run_superseded` and the watcher process is still alive after a short timeout. Those checks SHALL assert the process exited and that the identity-terminal material line was emitted. Tests SHALL inject the events file and filter (or equivalent seam). Tests SHALL NOT start a live train, live messenger, or live ship.

#### Scenario: Regression fails on the v1.40.0 tail hang

- **WHEN** the automated checks spawn bundled `ship-stage-watch` follow mode against a fixture events file
- **AND** that file contains or receives `loop_run_superseded`
- **AND** the watcher process is still alive after the test timeout
- **THEN** the checks SHALL fail

#### Scenario: Regression passes when follow exits after superseded

- **WHEN** the automated checks spawn bundled `ship-stage-watch` follow mode against a fixture events file
- **AND** that file contains or receives `loop_run_superseded`
- **AND** the watcher process exits after emitting the material line
- **THEN** the checks SHALL pass
