## ADDED Requirements

### Requirement: Noop-clean does-not-reproduce at green live head SHALL not escalate solely on prior-head exhaustion

When the bounded pre-merge autofix harness exits noop-clean (no new commit, clean worktree) or reports does-not-reproduce for the findings under repair at the live open PR head H, and CI for H is green under the active `ci_mode`, the pipeline SHALL complete the existing clean-noop re-verify / shared noop-advance evaluation at H before any terminal block. If the only durable blocking keys or fail narratives remaining are scoped to a prior head A ≠ H, the pipeline SHALL clear or re-scope residual block authority rather than escalate solely because the one autofix attempt is exhausted. True residual blocking findings re-verified at H still escalate under the existing one-attempt residual path.

#### Scenario: Autofix exhausted on stale keys does not park green tip

- **WHEN** autofix for the entry has already been attempted (budget exhausted)
- **AND** the attempt was noop-clean / does-not-reproduce at live head `H_green` with green CI
- **AND** residual durable keys exist only for prior head `H_fail ≠ H_green`
- **THEN** pre-merge SHALL NOT set `needs-human` solely for autofix-exhausted + those prior-head keys
- **AND** SHALL clear or re-verify at `H_green` so a clean re-verify can proceed

#### Scenario: Residual at live head after noop still escalates

- **WHEN** post-noop re-verify at live head H still reports residual blocking findings under the active policy
- **AND** the autofix attempt budget is exhausted
- **THEN** the pipeline SHALL escalate under existing residual one-attempt rules for H
- **AND** SHALL NOT launch a second autofix solely to re-verify

#### Scenario: Clean noop re-verify non-regression

- **WHEN** autofix ends noop-clean at head H and re-verify returns no blocking findings
- **THEN** pre-merge SHALL proceed (SHA gate returns null / equivalent) under existing clean-noop re-verify contracts
- **AND** SHALL NOT leave the issue blocked solely because no commit was produced

---

### Requirement: Escalation reasons for residual live-head blocks SHALL disclose both SHAs when a prior candidate was involved

When pre-merge escalates after autofix exhaustion because residual findings still block at the live head H, and the entry also carried fail evidence or finding keys from a prior candidate SHA A ≠ H, the block reason / comment SHALL name both A and H and SHALL state whether an audited `pipeline override` of residual finding keys is required. This disclosure MUST NOT be used to auto-override residual findings at H.

#### Scenario: Dual-SHA disclosure on residual escalate

- **WHEN** residual findings still block at live head H after autofix exhaustion
- **AND** earlier fail or finding keys for prior candidate A were part of the entry history
- **THEN** the `setBlocked` reason or blocked comment SHALL include both A and H
- **AND** SHALL state whether override is required for residual keys at H
