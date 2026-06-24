## MODIFIED Requirements

### Requirement: Stranded `planning` and `plan-review` states SHALL be restarted, not waited on

The advance-loop dispatch table SHALL treat the `planning` and `plan-review` stages as
crash-stranded when control reaches the dispatch (i.e. the per-issue lock is held by the
current process). Rather than returning a `waiting` outcome, the dispatcher SHALL roll the
issue back to `ready` via a `transition()` call and then restart the planning arc by calling
`planningStage.advance()`, identical to the path taken when the issue is on `ready`.

The dispatcher SHALL log a one-line diagnostic before performing the rollback:
`[pipeline] #N: recovered stranded planning attempt — restarting from ready`

The rationale: the per-issue lock (`/tmp/pipeline-{domain}-{N}.lock`) is the only
serialization gate for concurrent planning runs on the same issue. By the time
`dispatchStage()` is entered, the lock has already been acquired. If a genuine concurrent
planning run were active, the lock acquisition would have failed earlier and the current
process would have exited before reaching the dispatch table. Therefore, at dispatch time,
`planning` and `plan-review` always mean crash-stranded — never genuinely in-flight.

#### Scenario: stranded `planning` restarts without operator intervention

- **WHEN** an issue carries `pipeline:planning` and the advance loop acquires the per-issue
  lock and enters the dispatch table
- **THEN** the dispatcher SHALL NOT return `{ status: "waiting" }`
- **AND** SHALL roll the issue back to `pipeline:ready` via a `transition()` call with a
  message referencing the crash recovery
- **AND** SHALL invoke `planningStage.advance()` as if the issue had been on `ready`
- **AND** SHALL print `[pipeline] #N: recovered stranded planning attempt — restarting from
  ready` before the rollback

#### Scenario: stranded `plan-review` is treated identically

- **WHEN** an issue carries `pipeline:plan-review` and the advance loop acquires the
  per-issue lock and enters the dispatch table
- **THEN** the dispatcher SHALL NOT return `{ status: "waiting" }`
- **AND** SHALL roll the issue back to `pipeline:ready` via a `transition()` call
- **AND** SHALL invoke `planningStage.advance()` to restart the full planning arc from scratch

#### Scenario: concurrent planning still blocked by the lock

- **WHEN** process A holds the per-issue lock and is actively planning issue N
- **AND** process B attempts `pipeline N` for the same issue N and same domain
- **THEN** process B SHALL fail at lock acquisition and SHALL NOT reach the dispatch table
- **AND** SHALL print the existing "lock held by another process" error

#### Scenario: loop advance outcome on recovery is not `waiting`

- **WHEN** the dispatch table processes a stranded `planning` or `plan-review` issue and
  `planningStage.advance()` succeeds
- **THEN** the returned `Outcome` SHALL have `advanced: true`
- **AND** the transition count SHALL increment (the run is not a 0-transition no-op)
