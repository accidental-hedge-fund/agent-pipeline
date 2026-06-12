## MODIFIED Requirements

### Requirement: Blocked state halts the advance loop
When an issue carries the `blocked` label (`BLOCKED_LABEL = "blocked"`), the advance loop SHALL stop and surface the latest blocker comment — except at `implementing`, where auto-recovery is attempted first; if recovery succeeds the loop continues, otherwise it stops. The "## Pipeline: Blocked" comment posted by `setBlocked` SHALL render a kind-specific "### How to unblock" section drawn from the `BlockerKind` enum and the `BLOCKER_RECIPES` map; the section SHALL NOT use the generic `--unblock` instruction for blocker classes where `--unblock` is not the correct recovery verb.

#### Scenario: blocked issue stops the loop
- **WHEN** the current issue carries the `blocked` label at `review-1`
- **THEN** the loop SHALL stop and surface the blocker rather than dispatching the stage

#### Scenario: blocked comment contains kind-specific recipe
- **WHEN** `setBlocked` is called with `kind = "test-gate-exhausted"`
- **THEN** the posted comment SHALL include a "### How to unblock" section with the test-gate recipe
- **AND** the section SHALL NOT instruct the operator to run `--unblock`
