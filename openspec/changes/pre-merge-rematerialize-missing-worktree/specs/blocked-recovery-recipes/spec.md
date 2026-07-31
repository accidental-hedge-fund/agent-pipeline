## ADDED Requirements

### Requirement: worktree-missing recipe SHALL stay accurate when rematerialize is in scope

The `BLOCKER_RECIPES` entry for `worktree-missing` SHALL remain non-empty and actionable. After pre-merge/fix paths rematerialize missing managed worktrees automatically, the recipe SHALL NOT claim that re-running the pipeline will always block immediately without recreation for those paths. When a residual `worktree-missing` or rematerialize-failed park still occurs, the recipe (or the blocking reason paired with `worktree-creation-failed`) SHALL direct the operator at concrete recovery: verify remote branch / open PR recoverability, auth/`gh` access, free worktree capacity, resolve dirty or local-only reclaim blockers under the managed root, remove the `blocked` label when appropriate, then re-run the pipeline. The recipe suite SHALL fail if the text falsely asserts that re-run never recreates the worktree while scoped call sites rematerialize on re-entry.

#### Scenario: Recipe does not deny automatic rematerialize on scoped re-entry

- **WHEN** the rendered `worktree-missing` recipe for issue N is inspected after this change ships
- **THEN** it SHALL NOT state that re-running will always block immediately solely because recreation never runs
- **AND** it SHALL still give an operator a concrete recovery path when rematerialize cannot succeed

#### Scenario: worktree-creation-failed remains the preferred kind after failed create/rematerialize

- **WHEN** rematerialize is attempted and `createWorktree` fails
- **THEN** the call site SHALL use `worktree-creation-failed` (or `worktree-capacity` when capacity-typed) for the block kind
- **AND** the corresponding recipe SHALL continue to cover config-lock / dangling-branch / capacity recovery as already specified
