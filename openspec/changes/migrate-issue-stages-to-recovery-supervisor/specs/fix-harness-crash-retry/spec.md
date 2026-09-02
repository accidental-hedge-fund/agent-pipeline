## MODIFIED Requirements

### Requirement: A failed fix-round harness invocation SHALL be retried in place up to the auto-recovery cap

The fix stage (`fix-1`, `fix-2`) SHALL treat a harness invocation that reports failure (non-zero exit or timeout) as an operation observation rather than a stage-local lifecycle retry loop, except when the result is a typed production-preflight refusal (`preflight_failed`) or `harness-background-wait`. The adapter SHALL perform one bounded attempt. RecoverySupervisor SHALL own subsequent treatment, Cooling, and re-entry. A typed `capability-refusal` preflight SHALL remain a typed observation without transport retry and SHALL keep that reason code, `preflight_class`, intervention kind, and bounded message.

A structured failure *verdict* produced by a successful invocation is not a harness failure and SHALL NOT be classified as a crash observation.

If RecoverySupervisor re-enters the fix adapter, that re-entry SHALL use the same worktree and SHALL NOT discard crashed-attempt work. `auto_recovery_max_retries` SHALL NOT be a stage-local terminalizing budget. Exhausting a strategy-cursor cap SHALL enter Cooling or another owned treatment. It SHALL NOT mark the Logical Operation complete, cancelled, or human-owned. A compatibility `setBlocked` projection with `blockerKind: "harness-failure"` MAY still be emitted.

#### Scenario: Persistently crashing harness is invoked cap+1 times, then blocks

- **WHEN** `auto_recovery_max_retries` is 2 and the fix-2 harness invocation returns `{ success: false, exit_code: 1 }` on every attempt
- **THEN** RecoverySupervisor MAY re-enter the adapter so the harness is invoked at most 3 times across owned attempts
- **AND** SHALL then emit a compatibility blocked projection with `blockerKind: "harness-failure"` if that treatment is selected
- **AND** the blocked reason SHALL reference the final attempt's failure (`exit 1`)
- **AND** the Logical Operation SHALL remain owned
- **AND** the adapter SHALL NOT mark the operation complete, cancelled, or human-owned

#### Scenario: Retry succeeds and the round advances normally

- **WHEN** the first fix-2 harness invocation fails with `exit 1` and a RecoverySupervisor re-entry succeeds and produces a new commit
- **THEN** the pipeline SHALL NOT treat the failed attempt as a lifecycle terminal
- **AND** the round SHALL proceed through the unchanged downstream gates (commit-message gate, OpenSpec delta validation, format/test gates) and transition `fix-2 → pre-merge`

#### Scenario: fix-1 retry success advances to review-2

- **WHEN** a fix-1 harness invocation fails and a RecoverySupervisor re-entry succeeds with a new commit
- **THEN** the stage SHALL transition `fix-1 → review-2` exactly as an uninterrupted fix-1 round would

#### Scenario: Retries disabled by configuration

- **WHEN** `auto_recovery_max_retries` is 0 and the fix harness invocation fails
- **THEN** the pipeline SHALL invoke the harness exactly once for that adapter attempt
- **AND** RecoverySupervisor SHALL retain ownership as Cooling or another owned treatment
- **AND** a compatibility blocked projection MAY still use `blockerKind: "harness-failure"`

#### Scenario: Structured failure verdict is not retried

- **WHEN** the fix harness invocation returns `success: true` but the round produces no commit
- **THEN** the crash path SHALL NOT re-invoke the harness as a crash retry
- **AND** the existing salvage / external-commit / does-not-reproduce / no-commits evaluation SHALL run and report as specified by `noop-advance-contract`

#### Scenario: Typed production-preflight refusal is not retried

- **WHEN** the fix harness invocation returns `preflight_failed: true` with `preflight_reason_code: capability-refusal`
- **THEN** the pipeline SHALL invoke the harness exactly once
- **AND** SHALL NOT emit `fix_harness_retry` as a stage-local lifecycle loop
- **AND** SHALL emit a typed `capability-refusal` observation, not a bare `exit -1` reason mapped as `workflow-engine-defect`
- **AND** the observation SHALL retain `preflight_class` and intervention kind `auth-tooling-preflight-failure`
- **AND** SHALL record zero harness sessions

### Requirement: Retries SHALL honor the remaining stage timeout budget

Each RecoverySupervisor re-entry of the fix adapter SHALL be given a `timeoutSec` equal to `fix_timeout` minus the wall-clock seconds already consumed by prior attempts of this stage invocation, and SHALL never be given the full `fix_timeout` again. When the remaining budget is at or below a usable floor, RecoverySupervisor SHALL NOT start another adapter attempt and SHALL enter Cooling or another owned treatment with a reason naming budget exhaustion. The adapter SHALL NOT start a stage-local retry loop.

#### Scenario: Second attempt receives the remaining budget

- **WHEN** `fix_timeout` is 2400 seconds and the first attempt fails after 780 seconds
- **AND** RecoverySupervisor re-enters the adapter
- **THEN** the re-entry invocation SHALL be called with a `timeoutSec` of at most 1620 seconds
- **AND** SHALL NOT be called with 2400

#### Scenario: Remaining budget below the floor blocks instead of retrying

- **WHEN** `fix_timeout` is 2400 seconds, `auto_recovery_max_retries` is 2, and the first attempt
  fails after 2395 seconds
- **THEN** no further harness invocation SHALL be made
- **AND** RecoverySupervisor SHALL retain ownership as Cooling or another owned treatment
- **AND** a compatibility blocked projection MAY use `blockerKind: "harness-failure"` with a reason indicating the remaining fix-timeout budget was exhausted

#### Scenario: A timed-out attempt is retried within the residual budget

- **WHEN** the first attempt reports `timed_out: true` and residual budget remains above the floor
- **AND** RecoverySupervisor selects re-entry
- **THEN** a re-entry SHALL be invoked with the residual budget as its `timeoutSec`

### Requirement: The retry path SHALL never discard or reset the crashed attempt's work

No step of the fix-stage crash path or RecoverySupervisor re-entry SHALL remove the worktree or revert working-tree content solely because the harness crashed. Specifically, the path SHALL NOT invoke `removeWorktree`, `git reset`, `git checkout -- <path>`, `git clean`, or `git restore` against working-tree content, at any attempt number including after strategy-cursor exhaustion. Uncommitted changes left by a crashed attempt SHALL still be present in the worktree when the next RecoverySupervisor re-entry starts and when a compatibility blocked projection is emitted. Unknown dirt SHALL still be preserved as specified by `engine-scratch-recover`.

#### Scenario: No destructive git or worktree call across an exhausted retry sequence

- **WHEN** a fix round harness crashes and RecoverySupervisor exhausts crash re-entry
- **THEN** the injected worktree/git seams SHALL record no `removeWorktree`, `reset`, `clean`, `checkout --`, or working-tree `restore` invocation caused by that crash path
- **AND** the uncommitted changes present before the first failure SHALL still be reported by `git status --porcelain` after the observation is recorded

#### Scenario: Implementing-stage auto-recovery is unaffected

- **WHEN** an item is blocked at `pipeline:implementing` with no commits ahead of base
- **THEN** `tryAutoRecover` SHALL claim or resume the same Recovery Episode
- **AND** SHALL NOT independently remove the worktree and reset the issue to `pipeline:ready` as a second controller
- **AND** RecoverySupervisor MAY select that treatment when dirt is pipeline-owned scratch

### Requirement: A retry invocation SHALL tell the harness that in-progress work is present

A RecoverySupervisor re-entry of a crashed fix round SHALL be given a prompt that differs from the first attempt's prompt by a retry addendum. The addendum SHALL state that a previous attempt of this same fix round terminated abnormally, that any uncommitted changes it produced are still present in the worktree, and that the harness SHALL review and complete that work rather than discarding it or restarting from scratch. The first attempt's prompt SHALL NOT contain the addendum.

#### Scenario: Retry prompt carries the in-progress-work addendum

- **WHEN** RecoverySupervisor re-enters the fix adapter after a failed attempt
- **THEN** the prompt passed to that invocation SHALL contain the retry addendum
- **AND** the addendum SHALL reference the prior attempt's failure reason and the presence of uncommitted work in the worktree
- **AND** the addendum SHALL instruct the harness to review and complete that work rather than discard or restart it

#### Scenario: First attempt prompt is unchanged

- **WHEN** the fix harness is invoked for the first attempt of a round
- **THEN** the prompt SHALL NOT contain the retry addendum
