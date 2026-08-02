## ADDED Requirements

### Requirement: Post-auto-fix no-op path SHALL align with shared goal-satisfaction evaluation

When the pre-merge delta path consumes a clean no-commit (`noop-clean`) bounded auto-fix outcome, it SHALL re-enter verification (delta re-review or equivalent HEAD check) and apply terminal disposition through the shared `noop-advance-contract` evaluation used by `pre-merge-fix-round`, rather than treating “no commit” alone as sufficient to set `blocked`/`needs-human`. Partition eligibility (non-empty allowlisted subset still auto-fixable despite residual non-allowlisted findings) and fail-closed behavior when re-verify still blocks SHALL remain as already specified. The path SHALL NOT bypass review-SHA currency, supersession, or other delta integrity rules.

#### Scenario: Clean auto-fix no-op does not skip re-verify

- **WHEN** the bounded auto-fix for a delta blocking round ends with a clean worktree and no new commit
- **THEN** the pipeline SHALL re-verify residual blocking findings at the current head before terminal block
- **AND** SHALL obtain proceed vs escalate via the shared noop-advance evaluation (or pre-merge adapter)
- **AND** SHALL NOT escalate solely because the auto-fix produced no commit when re-verify is clean

#### Scenario: Still-blocking re-verify fails closed without second auto-fix

- **WHEN** post-noop re-verify still reports residual blocking findings
- **THEN** the pipeline SHALL escalate under existing one-attempt exhaustion rules
- **AND** SHALL NOT launch a second bounded auto-fix solely to re-verify
