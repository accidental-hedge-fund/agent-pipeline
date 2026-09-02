## ADDED Requirements

### Requirement: Recovery Episode treatment history SHALL reuse the stage-attempt ledger

RecoverySupervisor SHALL record Recovery Episode treatment history through the existing stage-attempt ledger and the existing operation-claim records. Issue-stage adapters SHALL NOT persist a second terminalizing budget book (comment-counted auto-recovery caps, worktree marker files as sole authority, or process-local retry counters that end ownership). Exhausting one treatment SHALL advance the Recovery Episode strategy cursor. It SHALL NOT end lifecycle ownership.

#### Scenario: Auto-recovery comments are not the authority

- **WHEN** RecoverySupervisor evaluates whether a no-commit implementation treatment has already been attempted
- **THEN** it SHALL consult the stage-attempt ledger and the operation claim
- **AND** SHALL NOT treat auto-recovery comment markers as the sole production authority

#### Scenario: No third attempt schema

- **WHEN** Recovery Episode records and the stage-attempt ledger are inspected
- **THEN** they SHALL share the recovery-attempt record family (extended fields allowed)
- **AND** the engine SHALL NOT persist a competing private episode schema as production authority
