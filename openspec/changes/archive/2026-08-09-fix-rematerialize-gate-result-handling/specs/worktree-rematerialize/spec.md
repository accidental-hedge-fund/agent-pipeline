## ADDED Requirements

### Requirement: Rematerialize call sites SHALL accept pass and skipped success variants

Every stage path that evaluates `ensureManagedWorktree` (including design-gate, visual-gate, eval-gate, fix, pre-merge archive/autofix, and loop repair) SHALL treat the seam result as follows:

1. `result: "fail"` — park (or return a typed rematerialize failure) using the seam's `blockerKind` (`worktree-missing` | `worktree-creation-failed` | `worktree-capacity`) and a reason that names the rematerialize failure. The reason SHALL use the typed kind, not `undefined`.
2. `result: "pass"` with a non-null `worktree` — continue stage work using `worktree.path` / `worktree.slug`. SHALL NOT call `setBlocked` solely because rematerialize returned success.
3. `result: "skipped"` with a non-null `worktree` — continue stage work using that path (including races where another process recreated the tree between initial lookup and ensure). SHALL NOT treat `skipped` as failure.
4. Call sites SHALL NOT require a nonexistent success string such as `"ok"`. The only producer success values are `pass` and `skipped`.

A successful rematerialize reason (for example `recreated from open PR head …`) SHALL never appear inside a blocking reason of the form `rematerialize failed (undefined)`.

When a non-fail result is returned without a usable `worktree` path (defensive handling for type-stripped or injectable fakes), the call site MAY park as `worktree-missing` with a reason that names the returned result and states the path was missing — it SHALL NOT throw on null dereference and SHALL NOT format the reason as `failed (undefined)`.

#### Scenario: Design-gate continues after pass rematerialize

- **WHEN** design-gate requires a managed worktree and on-disk lookup returns none
- **AND** `ensureManagedWorktree` returns `result: "pass"` with a non-null worktree and reason describing recreate from open PR head
- **THEN** design-gate SHALL continue using the returned worktree path
- **AND** SHALL NOT `setBlocked` solely for that rematerialize outcome
- **AND** the blocking reason text SHALL NOT contain `failed (undefined)`

#### Scenario: Visual-gate continues after skipped rematerialize with path

- **WHEN** visual-gate requires a managed worktree and on-disk lookup returns none
- **AND** `ensureManagedWorktree` returns `result: "skipped"` with a non-null worktree
- **THEN** visual-gate SHALL continue using the returned worktree path for the visual command
- **AND** SHALL NOT park as `worktree-missing` solely because the result was `skipped`

#### Scenario: Eval-gate continues after pass rematerialize

- **WHEN** eval-gate requires a managed worktree and on-disk lookup returns none
- **AND** `ensureManagedWorktree` returns `result: "pass"` with a non-null worktree
- **THEN** eval-gate SHALL continue using the returned worktree path for the eval command
- **AND** SHALL NOT `setBlocked` solely for rematerialize success

#### Scenario: True fail retains typed blocker

- **WHEN** any of design-gate, visual-gate, or eval-gate calls `ensureManagedWorktree`
- **AND** the seam returns `result: "fail"` with `blockerKind` one of `worktree-missing`, `worktree-creation-failed`, or `worktree-capacity`
- **THEN** the stage SHALL park with that `blockerKind`
- **AND** the reason SHALL name the rematerialize failure using the typed kind (not `undefined`)

#### Scenario: Nonexistent ok success token is not required

- **WHEN** a rematerialize call site evaluates the seam result
- **THEN** the call site SHALL treat `pass` and `skipped` as the success vocabulary
- **AND** SHALL NOT require `result === "ok"` for continuation
