## ADDED Requirements

### Requirement: Pre-merge clean no-commit terminal disposition SHALL use the shared noop-advance contract

When a pre-merge bounded auto-fix attempt ends with a confirmed clean no-commit outcome (`noop-clean`: `headAfter === headBefore`, worktree clean, nothing salvageable), the terminal disposition — re-verify (or equivalent HEAD goal check) then **proceed** when findings are clear, or **escalate once** with the no-op-still-broken recipe when findings remain — SHALL be obtained through the shared `noop-advance-contract` evaluation (or a thin pre-merge adapter). The one-attempt bound, durable attempt/noop markers, category **partition** eligibility, residual human-required findings, dirty/timeout fail-closed paths, and allowlist membership SHALL remain as already specified by this capability. Clean no-commit alone SHALL NOT hard-block with `blocked`/`needs-human` without the goal/re-verify evaluation.

#### Scenario: Noop-clean re-verify clean proceeds via shared evaluation

- **WHEN** bounded auto-fix ends `noop-clean` and re-verify (or equivalent HEAD check) reports clean under existing partition policy
- **THEN** the shared evaluation (or adapter) SHALL return **advance**
- **AND** pre-merge SHALL proceed without `setBlocked` solely for the no-op
- **AND** attested evidence SHALL record the noop / already-satisfied rationale at the evaluated HEAD SHA

#### Scenario: Noop-clean re-verify still broken escalates via shared evaluation

- **WHEN** bounded auto-fix ends `noop-clean` and re-verify still reports residual blocking findings
- **THEN** the shared evaluation (or adapter) SHALL return **escalate**
- **AND** pre-merge SHALL escalate once with the existing no-op-still-broken operator recipe
- **AND** SHALL NOT launch a second bounded auto-fix solely for re-verify

#### Scenario: Mixed partition batch still re-verifies allowlisted noop through shared path

- **WHEN** a mixed allowlisted + residual human-required batch attempts auto-fix on the allowlisted subset only and that attempt ends `noop-clean`
- **THEN** terminal disposition SHALL use the shared evaluation after re-verify
- **AND** residual human-required findings SHALL remain subject to human disposition as already required
- **AND** the path SHALL NOT hard-block solely because the allowlisted subset produced no commit
