## MODIFIED Requirements

### Requirement: A failed fix-round harness invocation SHALL be retried in place up to the auto-recovery cap

The fix stage (`fix-1`, `fix-2`) SHALL treat a harness invocation that reports failure (non-zero exit or timeout) as a retriable event rather than an immediate block, except when the result is a typed production-preflight refusal (`preflight_failed`) or `harness-background-wait`. The pipeline SHALL re-invoke the harness in the **same worktree** up to `auto_recovery_max_retries` additional times for crash and timeout failures. The stage SHALL block only after the cap is reached, and the block SHALL be identical in kind to today's (`blockerKind: "harness-failure"`, human-intervention kind `reviewer-unavailable`) unless the result carries a typed preflight reason. A typed `capability-refusal` preflight SHALL block without retry and SHALL keep that reason code.

A structured failure *verdict* produced by a successful invocation is not a harness failure and SHALL NOT trigger this retry path.

#### Scenario: Persistently crashing harness is invoked cap+1 times, then blocks

- **WHEN** `auto_recovery_max_retries` is 2 and the fix-2 harness invocation returns `{ success: false, exit_code: 1 }` on every attempt
- **THEN** the pipeline SHALL invoke the harness exactly 3 times
- **AND** SHALL then return a blocked outcome with `blockerKind: "harness-failure"`
- **AND** the blocked reason SHALL reference the final attempt's failure (`exit 1`)

#### Scenario: Retry succeeds and the round advances normally

- **WHEN** the first fix-2 harness invocation fails with `exit 1` and the retry invocation succeeds and produces a new commit
- **THEN** the pipeline SHALL NOT set a blocker for the failed attempt
- **AND** the round SHALL proceed through the unchanged downstream gates (commit-message gate, OpenSpec delta validation, format/test gates) and transition `fix-2 → pre-merge`

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
- **AND** the existing salvage / external-commit / does-not-reproduce / no-commits block sequence SHALL run unchanged

#### Scenario: Typed production-preflight refusal is not retried

- **WHEN** the fix harness invocation returns `preflight_failed: true` with `preflight_reason_code: capability-refusal`
- **THEN** the pipeline SHALL invoke the harness exactly once
- **AND** SHALL NOT emit `fix_harness_retry`
- **AND** SHALL block with a typed `capability-refusal` diagnostic, not a bare `exit -1` reason mapped as `workflow-engine-defect`
