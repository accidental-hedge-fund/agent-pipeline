# worktree-per-run-removal

## MODIFIED Requirements

### Requirement: Per-issue worktree removal via flag
The pipeline SHALL accept a `--remove-worktree` flag on `pipeline N` invocations. When supplied, the pipeline SHALL locate the pipeline-managed worktree for issue N by selecting the Git-registered worktree record whose issue identity is N and whose path lies under one of the managed roots resolved per `managed-worktree-resolution` — regardless of which checkout of the shared Git common directory the command is invoked from — remove it (worktree directory deregistered from git AND local branch deleted), and exit without running any pipeline-advance logic. It SHALL NOT recompute the managed root from `cfg.repo_dir` alone. The remote branch SHALL NOT be touched. A worktree that is not Git-registered, or whose path lies under no managed root, SHALL NOT be removed.

#### Scenario: Clean worktree is removed
- **WHEN** the operator invokes `pipeline N --remove-worktree`
- **AND** a pipeline-managed worktree for issue N exists on disk
- **AND** the worktree has no uncommitted changes (`git status --porcelain` returns empty)
- **THEN** the worktree directory is removed from disk
- **AND** `git worktree list` no longer includes the worktree
- **AND** the local branch `pipeline/<N>-<slug>` is deleted
- **AND** the remote branch is NOT deleted or modified
- **AND** the process exits zero

#### Scenario: Worktree created from a linked checkout is removed from the primary checkout
- **WHEN** a Pipeline worktree for issue N was created from a linked checkout (and therefore carries the pipeline ownership marker per the requirement below) and is registered at `<linked>/<worktree_root>/pipeline-N-<slug>` on branch `pipeline/N-<slug>`
- **AND** the operator invokes `pipeline N --remove-worktree` from the primary checkout of the same Git common directory
- **THEN** that worktree SHALL be resolved and removed
- **AND** the reported `worktree` path SHALL be `<linked>/<worktree_root>/pipeline-N-<slug>`
- **AND** the reported `branch` SHALL be `pipeline/N-<slug>`

#### Scenario: Removal works from a third linked checkout
- **WHEN** the command is invoked from a linked checkout that is neither the primary checkout nor the checkout under which the worktree was created
- **THEN** the same worktree record SHALL be resolved and removed

#### Scenario: A developer-owned worktree on a pipeline branch is never removed
- **WHEN** a worktree on branch `pipeline/N-<slug>` is registered at a path under no managed root
- **AND** the operator invokes `pipeline N --remove-worktree`
- **THEN** no `git worktree remove` and no `git branch -D` SHALL be invoked
- **AND** the result SHALL report the not-found condition

#### Scenario: A similarly named unregistered directory is never removed
- **WHEN** a directory named `pipeline-N-<slug>` exists under a managed root but is absent from `git worktree list --porcelain` output
- **THEN** it SHALL NOT be selected for removal

#### Scenario: No worktree found exits non-zero
- **WHEN** the operator invokes `pipeline N --remove-worktree`
- **AND** no pipeline-managed worktree for issue N is registered under any managed root
- **THEN** an error is printed naming issue N and the managed roots that were searched
- **AND** no removal operation is invoked
- **AND** the process exits non-zero

#### Scenario: Command works regardless of PR merge state
- **WHEN** the operator invokes `pipeline N --remove-worktree`
- **AND** a worktree for issue N is present on disk
- **AND** the PR for issue N is open (not yet merged)
- **THEN** the worktree is removed (same behavior as if the PR were merged)
- **AND** the process exits zero (assuming the worktree is clean)

## ADDED Requirements

### Requirement: An ambiguous managed match SHALL fail closed
When more than one Git-registered, managed-root worktree record matches issue N, the pipeline SHALL refuse the removal, SHALL NOT invoke any removal or branch-deletion operation, and SHALL report an error naming every candidate path and directing the operator to remove the intended worktree explicitly. The pipeline SHALL NOT apply a tie-break heuristic to pick one candidate.

#### Scenario: Two managed candidates block removal
- **WHEN** worktrees for issue N are registered under two different checkouts' managed roots
- **AND** the operator invokes `pipeline N --remove-worktree`
- **THEN** `removed` SHALL be `false` and `worktree` SHALL be `null`
- **AND** the error SHALL name both candidate paths
- **AND** neither `git worktree remove` nor `git branch -D` SHALL be invoked
- **AND** the process exits non-zero

#### Scenario: Ambiguity is not bypassable with --force
- **WHEN** the same invocation adds `--force`
- **THEN** the removal SHALL still be refused with the same ambiguity error

---

### Requirement: Existing removal safety behavior SHALL be preserved for cross-checkout records
Resolving a worktree through the managed-root set SHALL NOT change any subsequent safety behavior. For a cross-checkout record, the dirty-worktree block, the local-only-commit tiers (definite block, `unverifiable` soft block, verification-failure hard block), the `--force` semantics, the stale-registration path, the `--json` field set, and the exit-code rules SHALL be identical to those applied to a worktree under the invoking checkout's own root.

#### Scenario: Dirty cross-checkout worktree still blocks without --force
- **WHEN** a cross-checkout worktree for issue N has uncommitted changes
- **AND** the operator invokes `pipeline N --remove-worktree` without `--force`
- **THEN** the worktree SHALL NOT be removed
- **AND** the reported result SHALL be identical in shape and values to the same case under the invoking checkout's own root

#### Scenario: Local-only commits still block a cross-checkout worktree
- **WHEN** a cross-checkout worktree's branch has commits not present on the remote
- **THEN** the removal SHALL be refused even with `--force`

#### Scenario: Single-checkout behavior is unchanged
- **WHEN** the repository has exactly one registered checkout
- **THEN** every removal outcome (clean removal, dirty-without-force, dirty-with-force, stale registration, not-found) SHALL return the same result object as before this change

---

### Requirement: A cross-checkout removal candidate SHALL require proof of pipeline ownership
Git registration, path placement under a managed root, and branch naming alone SHALL NOT be treated as proof that the pipeline created a worktree found under a *different* checkout's managed root than the one `--remove-worktree` was invoked from — a developer's own linked checkout of the same Git common directory can independently register a nested worktree matching the same path and branch conventions by coincidence. `createWorktree` SHALL stamp every worktree it creates with a durable, per-worktree ownership marker stored outside the working tree (so it is invisible to `git status` and is removed automatically when the worktree is deregistered). Before removing an on-disk candidate whose managed root differs from the invoking checkout's own root, the pipeline SHALL verify this marker is present and SHALL refuse the removal — invoking no `git worktree remove` or `git branch -D` — when it is absent. This gate SHALL NOT apply to a candidate under the invoking checkout's own managed root, preserving pre-existing single-checkout trust and behavior exactly.

#### Scenario: Cross-checkout worktree without the ownership marker is refused
- **WHEN** a worktree matching issue N's branch and directory-naming convention is registered under a linked checkout's managed root, other than the invoking checkout's own root
- **AND** that worktree was not created by `createWorktree` and therefore carries no ownership marker
- **AND** the operator invokes `pipeline N --remove-worktree` from a different checkout
- **THEN** the removal SHALL be refused
- **AND** neither `git worktree remove` nor `git branch -D` SHALL be invoked
- **AND** the error SHALL name the worktree path and state that no pipeline ownership marker was found
- **AND** the process exits non-zero

#### Scenario: A cross-checkout worktree created by the pipeline carries the marker and is removed
- **WHEN** `createWorktree` created the worktree for issue N from a linked checkout
- **AND** the operator invokes `pipeline N --remove-worktree` from a different checkout of the same Git common directory
- **THEN** the ownership marker SHALL be present
- **AND** the removal SHALL proceed exactly as described in "Worktree created from a linked checkout is removed from the primary checkout"

#### Scenario: The ownership gate does not apply to a same-checkout candidate
- **WHEN** the matched worktree's managed root is the invoking checkout's own root
- **THEN** the pipeline SHALL NOT consult the ownership marker before proceeding to the existing dirty/local-commits/force checks
