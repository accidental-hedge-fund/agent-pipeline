# blocked-recovery-recipes Specification

## Purpose
TBD - created by archiving change blocked-ux-stage-aware-recovery-recipe. Update Purpose after archive.
## Requirements
### Requirement: BlockerKind enum defines a closed set of blocker classes
The pipeline SHALL define a `BlockerKind` string-enum in `core/scripts/types.ts` covering every structurally-distinct failure class that can result in a blocked issue. The enum SHALL include at minimum: `needs-human`, `test-gate-exhausted`, `no-commits`, `harness-failure`, `openspec-invalid`, `openspec-stale-delta`, `merge-conflict`, `worktree-missing`, `worktree-creation-failed`, `pr-creation-failed`, `plan-gen-failed`, `push-failed`.

#### Scenario: BlockerKind enum is exhaustive for all call sites
- **WHEN** every `setBlocked(...)` call in `planning.ts`, `fix.ts`, and `pre_merge.ts` is inspected
- **THEN** each call SHALL pass a `kind` value drawn from `BlockerKind`
- **AND** no call SHALL be added without a corresponding `BlockerKind` member

#### Scenario: BLOCKER_RECIPES map covers every kind
- **WHEN** the `BLOCKER_RECIPES` map is inspected at runtime
- **THEN** it SHALL contain a non-empty string entry for every value in the `BlockerKind` enum
- **AND** no `BlockerKind` value SHALL be absent from the map

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

### Requirement: Recovery recipes are pinned by snapshot tests
The pipeline test suite SHALL include a snapshot or string-assertion test that verifies the rendered comment text for every `BlockerKind` value. A recipe string that changes or goes missing SHALL cause the test to fail.

#### Scenario: snapshot test fails when a recipe string is changed
- **WHEN** the `BLOCKER_RECIPES` entry for any kind is edited
- **THEN** the corresponding snapshot assertion SHALL fail at `npm test`
- **AND** the failure message SHALL identify which kind's recipe changed

#### Scenario: snapshot test covers all kinds
- **WHEN** a new value is added to `BlockerKind`
- **THEN** there SHALL be a test asserting that `BLOCKER_RECIPES` contains a non-empty entry for that value
- **AND** the test SHALL fail if the entry is absent

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

