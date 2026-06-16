## MODIFIED Requirements

### Requirement: Blocked state halts the advance loop

When an issue carries the `blocked` label (`BLOCKED_LABEL = "blocked"`), the advance loop SHALL stop and surface the latest blocker comment — except at `implementing`, where auto-recovery is attempted first; if recovery succeeds the loop continues, otherwise it stops. The "## Pipeline: Blocked" comment posted by `setBlocked` SHALL render a kind-specific "### How to unblock" section drawn from the `BlockerKind` enum and the `BLOCKER_RECIPES` map; the section SHALL NOT use the generic `--unblock` instruction for blocker classes where `--unblock` is not the correct recovery verb.

When an issue at `implementing` is **not** blocked but the dispatch table is entered at that stage (re-entry at the start of a run), the pipeline SHALL check for a resumable worktree before returning "nothing to do" — see the `implementing-resume` capability.

#### Scenario: blocked issue stops the loop

- **WHEN** the current issue carries the `blocked` label at `review-1`
- **THEN** the loop SHALL stop and surface the blocker rather than dispatching the stage

#### Scenario: blocked comment contains kind-specific recipe

- **WHEN** `setBlocked` is called with `kind = "test-gate-exhausted"`
- **THEN** the posted GitHub comment SHALL contain the test-gate-exhausted recipe text under "### How to unblock"
- **AND** the section SHALL NOT instruct the operator to run `--unblock`

#### Scenario: implementing dispatch with commits — resumes rather than waits

- **WHEN** the advance loop dispatches stage `implementing` at the start of a run (re-entry)
- **AND** the issue does NOT carry the `blocked` label
- **AND** a worktree with commits ahead of the base branch exists for the issue
- **THEN** the dispatcher SHALL invoke the implementing-resume path rather than returning `{ status: "waiting" }`
