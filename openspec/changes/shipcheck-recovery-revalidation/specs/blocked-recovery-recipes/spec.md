## ADDED Requirements

### Requirement: head-drift blocker kind directs the operator to push the local fix

The `BlockerKind` enum SHALL include a `head-drift` member, used when the issue
worktree's local HEAD contains commits not present on the linked PR head (an
unpushed local fix). Its `BLOCKER_RECIPES` entry SHALL be a non-empty recipe that
directs the operator to push the local commits so the PR head includes the fix,
remove the `blocked` label, then re-run the pipeline; the recipe SHALL NOT instruct
the operator merely to clear the `blocked` label without pushing. Because the
existing "BLOCKER_RECIPES map covers every kind" and "Recovery recipes are pinned by
snapshot tests" requirements already range over every `BlockerKind`, the
`head-drift` entry SHALL be covered by those tests without a new test surface.

The `blockerKindToInterventionKind` mapping SHALL map `head-drift` to the
`merge-conflict-or-branch-drift` human-intervention kind, since head drift is a
branch-state divergence between the worktree and the PR.

#### Scenario: head-drift kind renders the push-the-fix recipe

- **WHEN** `setBlocked(cfg, N, reason, "shipcheck-gate", "head-drift")` is called
- **THEN** the "### How to unblock" section SHALL direct the operator to push the local commits (so the PR head includes the fix), remove the `blocked` label, and re-run the pipeline
- **AND** SHALL NOT consist solely of the generic clear-the-label instruction

#### Scenario: BLOCKER_RECIPES contains a non-empty head-drift entry

- **WHEN** the `BLOCKER_RECIPES` map is inspected at runtime
- **THEN** it SHALL contain a non-empty string entry for `head-drift`
- **AND** the existing recipe-coverage snapshot test SHALL fail if that entry is absent or emptied

#### Scenario: head-drift maps to a branch-drift intervention kind

- **WHEN** `blockerKindToInterventionKind("head-drift")` is called
- **THEN** it SHALL return `"merge-conflict-or-branch-drift"`
