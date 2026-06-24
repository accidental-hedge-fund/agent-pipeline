## MODIFIED Requirements

### Requirement: Stranded `planning` and `plan-review` states SHALL be restarted, not waited on

The advance-loop dispatch table SHALL treat the `planning` and `plan-review` stages as
crash-stranded when control reaches the dispatch (i.e. the per-issue lock is held by the
current process AND no live-planning marker is found for the same repo+issue).

Before performing a rollback, the dispatcher SHALL consult a repo-stable live-planning
marker (`/tmp/pipeline-planning-<owner>-<repo>-<N>.live`). If the marker is present and
its recorded PID is alive, a concurrent run from a different domain/worktree is actively
planning the issue; the dispatcher SHALL return a `waiting` outcome rather than rolling
back. If the marker is absent (or its PID is dead/stale), the issue is crash-stranded;
the dispatcher SHALL roll the issue back to `ready` via a `transition()` call and restart
the planning arc by calling `planningStage.advance()`, identical to the path taken when
the issue is on `ready`.

The `planningStage.advance()` function SHALL set the marker to the current PID before
starting any label transitions, and SHALL clear the marker in a `finally` block so that
crash-exit also removes the marker.

The dispatcher SHALL log a one-line diagnostic before performing the rollback:
`[pipeline] #N: recovered stranded planning attempt — restarting from ready`

#### Scenario: stranded `planning` restarts without operator intervention

- **WHEN** an issue carries `pipeline:planning` and the advance loop acquires the per-issue
  lock and enters the dispatch table
- **AND** the repo-stable live-planning marker is absent (no active process)
- **THEN** the dispatcher SHALL NOT return `{ status: "waiting" }`
- **AND** SHALL roll the issue back to `pipeline:ready` via a `transition()` call with a
  message referencing the crash recovery
- **AND** SHALL invoke `planningStage.advance()` as if the issue had been on `ready`
- **AND** SHALL print `[pipeline] #N: recovered stranded planning attempt — restarting from
  ready` before the rollback

#### Scenario: stranded `plan-review` is treated identically

- **WHEN** an issue carries `pipeline:plan-review` and the advance loop acquires the
  per-issue lock and enters the dispatch table
- **AND** the repo-stable live-planning marker is absent
- **THEN** the dispatcher SHALL NOT return `{ status: "waiting" }`
- **AND** SHALL roll the issue back to `pipeline:ready` via a `transition()` call
- **AND** SHALL invoke `planningStage.advance()` to restart the full planning arc from scratch

#### Scenario: concurrent planning still blocked by the lock (same domain)

- **WHEN** process A holds the per-issue lock and is actively planning issue N
- **AND** process B attempts `pipeline N` for the same issue N and same domain
- **THEN** process B SHALL fail at lock acquisition and SHALL NOT reach the dispatch table
- **AND** SHALL print the existing "lock held by another process" error

#### Scenario: concurrent planning from a different domain is detected via the live marker

- **WHEN** process A is actively planning issue N under domain `domain-A`
- **AND** process B uses a different domain `domain-B` (different worktree basename) for the
  same repo and issue N, acquires its own domain-B lock, and reaches the dispatch table
- **THEN** process B SHALL check the repo-stable live-planning marker
- **AND** SHALL find the marker set by process A with a live PID
- **AND** SHALL return `{ status: "waiting" }` without rolling back or starting a new planning arc

#### Scenario: loop advance outcome on recovery is not `waiting`

- **WHEN** the dispatch table processes a stranded `planning` or `plan-review` issue and
  `planningStage.advance()` succeeds
- **THEN** the returned `Outcome` SHALL have `advanced: true`
- **AND** the transition count SHALL increment (the run is not a 0-transition no-op)
