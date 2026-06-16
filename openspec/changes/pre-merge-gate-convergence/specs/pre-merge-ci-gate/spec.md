## ADDED Requirements

### Requirement: CI failure with rebase guard exhausted blocks to needs-human

When CI check runs are definitively failing (not pending) and the per-worktree rebase marker has already been set (rebase guard exhausted), the pre-merge gate SHALL call `setBlocked` with the `needs-human` label and a reason that names each failing check, then return `blocked`. It SHALL NOT return `waiting`.

#### Scenario: CI failing, rebase already attempted — block immediately

- **WHEN** `getPrChecks` returns one or more definitively-failed check runs
- **AND** the per-worktree rebase marker (`rebaseAlreadyAttempted`) is set
- **THEN** the gate SHALL call `setBlocked` with label `needs-human` and a reason listing the failing check names
- **AND** SHALL return `{ advanced: false, status: "blocked", reason: "CI failed" }`
- **AND** SHALL NOT return `waiting` or attempt another rebase

#### Scenario: CI failing, rebase attempt fails — block immediately

- **WHEN** `getPrChecks` returns one or more definitively-failed check runs
- **AND** `rebaseAlreadyAttempted` is false (first attempt)
- **AND** `tryRebaseAndPush` returns false (rebase or push could not complete)
- **THEN** the gate SHALL call `setBlocked` with label `needs-human` and a reason listing the failing check names
- **AND** SHALL return `{ advanced: false, status: "blocked", reason: "CI failed" }`

#### Scenario: CI failing, first rebase succeeds — wait for CI to re-run

- **WHEN** `getPrChecks` returns one or more definitively-failed check runs
- **AND** `rebaseAlreadyAttempted` is false (first attempt)
- **AND** `tryRebaseAndPush` returns true
- **THEN** the gate SHALL mark the rebase as attempted
- **AND** SHALL return `{ advanced: false, status: "waiting", reason: "rebased; CI re-running" }`

### Requirement: Block reason names the failing checks

When the pre-merge gate blocks due to CI failure, the block reason SHALL include the name and bucket of each failing check run so the operator can identify which check to fix without querying GitHub manually.

#### Scenario: failing check names are surfaced in the block comment

- **WHEN** the gate calls `setBlocked` due to a CI failure
- **THEN** the reason text SHALL contain the name and status of each check in `agg.failed`
- **AND** SHALL NOT use only a generic message without check details
