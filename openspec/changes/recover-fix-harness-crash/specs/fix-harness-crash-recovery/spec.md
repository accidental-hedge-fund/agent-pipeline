## ADDED Requirements

### Requirement: A crashed fix-stage harness SHALL be retried up to the auto-recovery cap

The fix stage SHALL classify a harness invocation that returns `success === false` with
`timed_out !== true` as a **crash**, and SHALL re-invoke the harness for the same fix round rather
than blocking on the first crash. The number of additional attempts SHALL be capped at
`cfg.auto_recovery_max_retries`; no new configuration key SHALL be introduced. A harness result that
cannot be classified as a crash SHALL take the existing immediate-block path (fail closed).

#### Scenario: Crash then success — the round completes without human intervention

- **WHEN** the fix-round harness exits non-zero without timing out
- **AND** `cfg.auto_recovery_max_retries` is at least 1
- **THEN** the pipeline SHALL invoke the fix harness again for the same round
- **AND** when that attempt succeeds, the stage SHALL continue into the existing post-harness path
  (uncommitted-work salvage, commit gates, format/test gates, stage transition) unchanged
- **AND** SHALL NOT set a blocked label or emit a `human_intervention` event

#### Scenario: Crash on every attempt — block after the cap

- **WHEN** the fix-round harness crashes on the initial attempt and on every retry
- **AND** `cfg.auto_recovery_max_retries` is 2
- **THEN** the pipeline SHALL make exactly 3 harness invocations for that round
- **AND** SHALL then block via `setBlocked` with blocker kind `harness-failure`
- **AND** the blocked reason SHALL name the number of attempts made

#### Scenario: Retries disabled — behavior identical to today

- **WHEN** `cfg.auto_recovery_max_retries` is 0 and the fix-round harness crashes
- **THEN** the pipeline SHALL make exactly 1 harness invocation
- **AND** SHALL block with the existing `exit <code>` reason and blocker kind `harness-failure`

#### Scenario: Harness timeout is not a crash and is not retried

- **WHEN** the fix-round harness invocation returns `timed_out === true`
- **THEN** the pipeline SHALL make no further invocation for that round
- **AND** SHALL block with the existing `timed out after <N>s` reason and blocker kind
  `harness-failure`

### Requirement: Fix-crash retries SHALL be bounded by the remaining stage budget

Each retry SHALL be invoked with a `timeoutSec` equal to `cfg.fix_timeout` minus the wall-clock time
already consumed by previous attempts of the same fix round, never the full `cfg.fix_timeout`. When
the remaining budget is below the minimum-retry floor, the pipeline SHALL NOT invoke another attempt
and SHALL block. The wall-clock spent on a fix round across all attempts SHALL therefore remain
bounded by `cfg.fix_timeout` plus per-attempt process-teardown overhead.

#### Scenario: Retry receives the remaining budget

- **WHEN** `cfg.fix_timeout` is 2400 seconds and the crashed attempt consumed 780 seconds
- **THEN** the retry SHALL be invoked with `timeoutSec` of approximately 1620 seconds
- **AND** SHALL NOT be invoked with 2400 seconds

#### Scenario: Remaining budget below the floor — no retry

- **WHEN** the remaining stage budget after a crash is below the minimum-retry floor
- **THEN** the pipeline SHALL NOT invoke another attempt
- **AND** SHALL block with blocker kind `harness-failure` and a reason naming budget exhaustion

### Requirement: The retry prompt SHALL direct the harness to resume the crashed attempt's uncommitted work

When the managed worktree is dirty at retry time, the retry prompt SHALL be the round's normal fix
prompt prefixed with a resumption preamble that states uncommitted in-progress work from the crashed
attempt exists in the worktree, lists the changed paths, and instructs the harness to review, correct,
and complete that work rather than discard it, reset it, or restart from scratch. When the worktree is
clean at retry time, the retry prompt SHALL be byte-identical to the initial attempt's prompt.

#### Scenario: Dirty worktree — preamble present with changed paths

- **WHEN** the fix harness crashes leaving an uncommitted service change and a new test file
- **THEN** the retry prompt SHALL contain the resumption preamble
- **AND** the preamble SHALL list both changed paths
- **AND** SHALL instruct the harness to complete the in-progress work rather than discard or restart it

#### Scenario: Clean worktree — no preamble

- **WHEN** the fix harness crashes and `git status --porcelain` in the worktree is empty
- **THEN** the retry prompt SHALL be byte-identical to the prompt used for the initial attempt

### Requirement: The fix-crash recovery path SHALL NOT discard or clean in-progress work

The recovery path SHALL NOT invoke any destructive git operation on the managed worktree — including
`git reset`, `git restore`, `git checkout --`, and `git clean` — and SHALL NOT remove the worktree.
Uncommitted changes present before a retry SHALL still be present when the retry begins.

#### Scenario: Uncommitted work survives the retry

- **WHEN** the fix harness crashes with uncommitted changes in the worktree
- **AND** the pipeline invokes a retry
- **THEN** no `git reset`, `git restore`, `git checkout --`, or `git clean` command SHALL be issued by
  the recovery path
- **AND** the worktree SHALL NOT be removed
- **AND** the uncommitted changes SHALL still be present at the start of the retry

#### Scenario: Uncommitted work survives an exhausted-retry block

- **WHEN** every attempt crashes and the pipeline blocks after the cap
- **THEN** the uncommitted changes SHALL remain in the worktree for human inspection
- **AND** the recovery path SHALL have issued no destructive git operation

### Requirement: Fix-crash recovery attempts SHALL be recorded in events.jsonl and the evidence bundle

Each recovery attempt SHALL append a `fix_harness_recovery` event to `events.jsonl` carrying the
stage, the attempt number, the cap, the crashed attempt's exit code, the remaining budget in seconds,
and whether the worktree was dirty. Each attempt SHALL also append a `RecoveryRecord` with
`trigger: "fix-harness-crash"` to the run's evidence bundle, rendered in the bundle summary. Both
recordings SHALL be best-effort and gated on the run/state directory being configured, so unit tests
produce no filesystem side effects.

#### Scenario: One event and one evidence record per attempt

- **WHEN** the fix harness crashes twice and succeeds on the third attempt
- **THEN** `events.jsonl` SHALL contain exactly 2 `fix_harness_recovery` events
- **AND** each SHALL carry the stage, attempt number, cap, exit code, remaining budget, and dirty flag
- **AND** the evidence bundle SHALL contain exactly 2 recovery records with trigger
  `fix-harness-crash`

#### Scenario: No run directory configured — no filesystem writes

- **WHEN** a fix-crash retry occurs and no run directory or state directory is configured
- **THEN** the retry SHALL proceed normally
- **AND** SHALL make no filesystem write for the event or the evidence record

### Requirement: Fix-crash recovery SHALL be injectable and covered by a biting regression test

The recovery loop SHALL take a `FixCrashRecoveryDeps` parameter with injectable clock, worktree-status,
and harness-invocation seams, following the existing `AdvanceReviewDeps` / `SalvageDeps` pattern. Unit
tests SHALL drive the loop entirely through those seams with no real subprocess, git, or network call,
and SHALL include a regression test that fails when the retry loop is removed.

#### Scenario: Unit test drives the loop with fakes only

- **WHEN** the tests script a crash-then-success sequence of harness results with a fake clock and a
  fake worktree status
- **THEN** the test SHALL assert the invocation count, the retry `timeoutSec`, and the retry prompt
  contents without invoking any real subprocess, git, or network call

#### Scenario: Regression test bites

- **WHEN** the retry loop is reverted so the first crash blocks immediately
- **THEN** the crash-then-success regression test SHALL fail
