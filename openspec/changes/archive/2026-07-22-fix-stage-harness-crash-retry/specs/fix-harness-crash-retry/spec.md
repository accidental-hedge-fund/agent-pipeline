# fix-harness-crash-retry

## ADDED Requirements

### Requirement: A failed fix-round harness invocation SHALL be retried in place up to the auto-recovery cap

The fix stage (`fix-1`, `fix-2`) SHALL treat a harness invocation that reports failure (non-zero
exit or timeout) as a retriable event rather than an immediate block. The pipeline SHALL re-invoke
the harness in the **same worktree** up to `auto_recovery_max_retries` additional times. The stage
SHALL block only after the cap is reached, and the block SHALL be identical in kind to today's
(`blockerKind: "harness-failure"`, human-intervention kind `reviewer-unavailable`).

A structured failure *verdict* produced by a successful invocation is not a harness failure and
SHALL NOT trigger this retry path.

#### Scenario: Persistently crashing harness is invoked cap+1 times, then blocks

- **WHEN** `auto_recovery_max_retries` is 2 and the fix-2 harness invocation returns
  `{ success: false, exit_code: 1 }` on every attempt
- **THEN** the pipeline SHALL invoke the harness exactly 3 times
- **AND** SHALL then return a blocked outcome with `blockerKind: "harness-failure"`
- **AND** the blocked reason SHALL reference the final attempt's failure (`exit 1`)

#### Scenario: Retry succeeds and the round advances normally

- **WHEN** the first fix-2 harness invocation fails with `exit 1` and the retry invocation succeeds
  and produces a new commit
- **THEN** the pipeline SHALL NOT set a blocker for the failed attempt
- **AND** the round SHALL proceed through the unchanged downstream gates (commit-message gate,
  OpenSpec delta validation, format/test gates) and transition `fix-2 → pre-merge`

#### Scenario: fix-1 retry success advances to review-2

- **WHEN** a fix-1 harness invocation fails and a retry succeeds with a new commit
- **THEN** the stage SHALL transition `fix-1 → review-2` exactly as an uninterrupted fix-1 round would

#### Scenario: Retries disabled by configuration

- **WHEN** `auto_recovery_max_retries` is 0 and the fix harness invocation fails
- **THEN** the pipeline SHALL invoke the harness exactly once
- **AND** SHALL block with the same reason and `blockerKind` as the pre-change behavior

#### Scenario: Structured failure verdict is not retried

- **WHEN** the fix harness invocation returns `success: true` but the round produces no commit
- **THEN** the crash-retry path SHALL NOT re-invoke the harness
- **AND** the existing salvage / external-commit / does-not-reproduce / no-commits block sequence
  SHALL run unchanged

### Requirement: Retries SHALL honor the remaining stage timeout budget

Each retry invocation SHALL be given a `timeoutSec` equal to `fix_timeout` minus the wall-clock
seconds already consumed by prior attempts of this stage invocation, and SHALL never be given the
full `fix_timeout` again. When the remaining budget is at or below a usable floor, the pipeline
SHALL NOT start another attempt and SHALL block with a reason naming budget exhaustion.

#### Scenario: Second attempt receives the remaining budget

- **WHEN** `fix_timeout` is 2400 seconds and the first attempt fails after 780 seconds
- **THEN** the retry invocation SHALL be called with a `timeoutSec` of at most 1620 seconds
- **AND** SHALL NOT be called with 2400

#### Scenario: Remaining budget below the floor blocks instead of retrying

- **WHEN** `fix_timeout` is 2400 seconds, `auto_recovery_max_retries` is 2, and the first attempt
  fails after 2395 seconds
- **THEN** no further harness invocation SHALL be made
- **AND** the stage SHALL block with `blockerKind: "harness-failure"` and a reason indicating the
  remaining fix-timeout budget was exhausted

#### Scenario: A timed-out attempt is retried within the residual budget

- **WHEN** the first attempt reports `timed_out: true` and residual budget remains above the floor
- **THEN** a retry SHALL be invoked with the residual budget as its `timeoutSec`

### Requirement: The retry path SHALL never discard or reset the crashed attempt's work

No step of the fix-stage crash-retry path SHALL remove the worktree or revert working-tree content.
Specifically, the path SHALL NOT invoke `removeWorktree`, `git reset`, `git checkout -- <path>`,
`git clean`, or `git restore` against working-tree content, at any attempt number including after
the cap is reached. Uncommitted changes left by a crashed attempt SHALL still be present in the
worktree when the next attempt starts and when the stage finally blocks.

#### Scenario: No destructive git or worktree call across an exhausted retry sequence

- **WHEN** every attempt of a fix round fails and the retry cap is reached
- **THEN** the injected worktree/git seams SHALL record no `removeWorktree`, `reset`, `clean`,
  `checkout --`, or working-tree `restore` invocation
- **AND** the uncommitted changes present before the first failure SHALL still be reported by
  `git status --porcelain` after the stage blocks

#### Scenario: Implementing-stage auto-recovery is unaffected

- **WHEN** an item is blocked at `pipeline:implementing`
- **THEN** the existing `tryAutoRecover` path (which removes the worktree and resets the issue to
  `pipeline:ready`) SHALL behave exactly as before this change

### Requirement: A retry invocation SHALL tell the harness that in-progress work is present

A retried fix-round invocation SHALL be given a prompt that differs from the first attempt's prompt
by a retry addendum. The addendum SHALL state that a previous attempt of this same fix round
terminated abnormally, that any uncommitted changes it produced are still present in the worktree,
and that the harness SHALL review and complete that work rather than discarding it or restarting
from scratch. The first attempt's prompt SHALL NOT contain the addendum.

#### Scenario: Retry prompt carries the in-progress-work addendum

- **WHEN** the fix harness is re-invoked after a failed attempt
- **THEN** the prompt passed to that invocation SHALL contain the retry addendum
- **AND** the addendum SHALL reference the prior attempt's failure reason and the presence of
  uncommitted work in the worktree
- **AND** the addendum SHALL instruct the harness to review and complete that work rather than
  discard or restart it

#### Scenario: First attempt prompt is unchanged

- **WHEN** the fix harness is invoked for the first attempt of a round
- **THEN** the prompt SHALL be byte-identical to the prompt built before this change
- **AND** SHALL NOT contain the retry addendum

### Requirement: Retry attempts and outcomes SHALL be recorded in run artifacts

Every retry attempt SHALL append an event to `events.jsonl` and SHALL be recorded in the evidence
bundle. The record SHALL identify the stage, the attempt number, the configured cap, and the
failure reason of the attempt that triggered the retry. Recording SHALL be best-effort: a failure
to write an event SHALL NOT change the stage outcome.

#### Scenario: One event per retry attempt

- **WHEN** a fix-2 round fails twice and succeeds on the third attempt with
  `auto_recovery_max_retries: 2`
- **THEN** `events.jsonl` SHALL contain two fix-harness-retry events
- **AND** each SHALL carry `stage: "fix-2"`, its attempt number, the limit `2`, and the triggering
  failure reason

#### Scenario: Evidence bundle records the attempts

- **WHEN** a state directory is configured and a fix-round retry occurs
- **THEN** the evidence bundle for the issue SHALL include a record of each retry attempt and its
  outcome

#### Scenario: Event-write failure does not change the outcome

- **WHEN** appending a retry event throws
- **THEN** the stage SHALL continue and produce the same outcome it would have produced with a
  successful write

### Requirement: Exhausted retries SHALL attempt salvage before blocking

After the retry cap is reached and before the terminal harness-failure block, the pipeline SHALL
attempt `trySalvageUncommittedWork` for the worktree. When a salvage commit is created, the round
SHALL continue through the same downstream verification a harness-authored commit receives. When
nothing is salvageable, the pipeline SHALL block exactly as today.

#### Scenario: Near-complete crashed diff is salvaged instead of abandoned

- **WHEN** every fix-2 attempt fails and the worktree contains uncommitted changes
- **THEN** the pipeline SHALL create a salvage commit per the `harness-uncommitted-salvage` spec
- **AND** the salvaged commit SHALL flow through the commit-message, OpenSpec, format and test
  gates unchanged
- **AND** SHALL NOT bypass any of them

#### Scenario: Clean worktree after exhausted retries blocks as today

- **WHEN** every fix attempt fails and `git status --porcelain` is empty
- **THEN** no salvage commit SHALL be created
- **AND** the stage SHALL block with `blockerKind: "harness-failure"` and a
  `reviewer-unavailable` human intervention, as before this change

### Requirement: The crash-retry logic SHALL be injectable and covered by a biting regression test

The retry loop SHALL be exercised through the existing `AdvanceFixDeps`-style dependency seams so
unit tests invoke no real harness, git, or network. The suite SHALL include a test that fails if
the retry loop is removed.

#### Scenario: Regression test bites without the fix

- **WHEN** the crash-retry loop is removed from the fix stage
- **THEN** the crashing-harness test SHALL observe exactly one harness invocation and fail

#### Scenario: Tests use fakes only

- **WHEN** the crash-retry tests run
- **THEN** they SHALL invoke no real subprocess, git command, or network call
