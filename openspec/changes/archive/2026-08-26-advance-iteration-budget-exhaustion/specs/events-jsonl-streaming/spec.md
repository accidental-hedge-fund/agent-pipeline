## ADDED Requirements

### Requirement: run_complete after non-terminal iteration-budget exhaustion SHALL carry a typed incomplete marker

The orchestrator SHALL still append a `run_complete` event when an advance invocation ends because `MAX_ITERATIONS` is exhausted at a non-terminal stage, so `pipeline logs --events --follow` can observe end-of-run. That `run_complete` event SHALL NOT have a terminal-success shape: it SHALL include an additive typed incomplete marker `stop_reason` whose value is `iteration-budget-exhausted`. `schema_version` SHALL remain `1`. The event SHALL still contain `final_state` (the non-terminal **pre-park** stage, never `blocked` solely because this path later applied a block) and `elapsed_ms`. The orchestrator SHALL write this event **before** setting a non-zero `process.exitCode`. It SHALL NOT call `process.exit()` for this path.

A `run_complete` for a successful `ready-to-deploy` finalize, a `needs-human` park, an in-loop `waiting`/`blocked` stop, or an in-loop auto-loop budget-exhaustion park SHALL NOT receive `stop_reason: "iteration-budget-exhausted"` solely because the run used many iterations.

#### Scenario: exhausted pre-merge run_complete is marked incomplete

- **WHEN** an advance invocation exhausts `MAX_ITERATIONS` at `pre-merge` and `finalizeRun` writes `run_complete`
- **THEN** that event SHALL contain `final_state` of `pre-merge`
- **AND** SHALL contain `stop_reason` equal to `iteration-budget-exhausted`
- **AND** `schema_version` SHALL remain `1`
- **AND** `final_state` SHALL NOT equal `blocked` solely because the path parked with `ci-exhausted`

#### Scenario: successful ready-to-deploy run_complete is not marked iteration-exhausted

- **WHEN** an advance invocation reaches `ready-to-deploy` and terminal finalize runs (in-loop or deferred)
- **THEN** the `run_complete` event SHALL contain `final_state` of `ready-to-deploy`
- **AND** SHALL NOT contain `stop_reason` equal to `iteration-budget-exhausted`

#### Scenario: in-loop waiting stop does not mark run_complete as iteration-exhausted

- **WHEN** the loop breaks on a `waiting` outcome before the iteration cap
- **AND** `finalizeRun` writes `run_complete`
- **THEN** that event SHALL NOT contain `stop_reason` equal to `iteration-budget-exhausted`

#### Scenario: waiting break on the last slot does not mark run_complete as iteration-exhausted

- **WHEN** the loop is on the last `MAX_ITERATIONS` slot and breaks on `waiting`
- **AND** `finalizeRun` writes `run_complete`
- **THEN** that event SHALL NOT contain `stop_reason` equal to `iteration-budget-exhausted`
