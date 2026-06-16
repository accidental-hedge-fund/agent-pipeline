## MODIFIED Requirements

### Requirement: setBlocked renders a kind-specific recovery recipe
The `setBlocked` function SHALL accept an optional `kind?: BlockerKind` parameter. When `kind` is provided, the "### How to unblock" section of the blocked comment SHALL render the static recipe string associated with that kind from `BLOCKER_RECIPES`. When `kind` is omitted, the function SHALL default to `needs-human` behavior for backward compatibility.

The `worktree-creation-failed` recipe SHALL include the following specific cleanup steps:
1. Remove the git config lock if present: `rm -f .git/config.lock`
2. Delete the dangling branch: `git branch -D pipeline/<N>-<slug>`
3. Remove the `blocked` label from the GitHub issue
4. Re-run the pipeline

#### Scenario: kind-specific recipe appears in blocked comment
- **WHEN** `setBlocked(cfg, N, reason, stage, "test-gate-exhausted")` is called
- **THEN** the posted GitHub comment SHALL contain the test-gate-exhausted recipe text under "### How to unblock"
- **AND** SHALL NOT contain the generic `--unblock` instruction

#### Scenario: needs-human kind renders the override/fix recipe
- **WHEN** `setBlocked(cfg, N, reason, stage, "needs-human")` is called
- **THEN** the "### How to unblock" section SHALL direct the operator to fix findings and re-run OR use `--override "<key>: <reason>"` to record a disposition

#### Scenario: test-gate-exhausted kind renders the test-fix recipe
- **WHEN** `setBlocked(cfg, N, reason, stage, "test-gate-exhausted")` is called
- **THEN** the "### How to unblock" section SHALL direct the operator to fix the failing tests, commit, and re-run the pipeline

#### Scenario: openspec-invalid kind renders the validate-and-fix recipe
- **WHEN** `setBlocked(cfg, N, reason, stage, "openspec-invalid")` is called
- **THEN** the "### How to unblock" section SHALL direct the operator to run `openspec validate <change>` locally, fix errors, commit, and re-run

#### Scenario: merge-conflict kind renders the rebase recipe
- **WHEN** `setBlocked(cfg, N, reason, stage, "merge-conflict")` is called
- **THEN** the "### How to unblock" section SHALL direct the operator to rebase on the latest target branch, resolve conflicts, push, and re-run

#### Scenario: missing kind defaults to needs-human recipe
- **WHEN** `setBlocked(cfg, N, reason, stage)` is called without a `kind` argument
- **THEN** the comment SHALL render the `needs-human` recipe (the pre-change behavior)
- **AND** no crash or validation error SHALL occur

#### Scenario: worktree-creation-failed kind renders config-lock cleanup recipe
- **WHEN** `setBlocked(cfg, N, reason, stage, "worktree-creation-failed")` is called
- **THEN** the "### How to unblock" section SHALL include `rm -f .git/config.lock`, `git branch -D pipeline/<N>-<slug>`, removing the `blocked` label, and re-running the pipeline
