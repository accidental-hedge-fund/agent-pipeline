## MODIFIED Requirements

### Requirement: Worktree created off the latest base; stale path reclaimed
`createWorktree` SHALL fetch and branch off the latest `origin/<base_branch>`. Before creating the new worktree, the pipeline SHALL reclaim same-issue managed worktrees and clear a colliding directory at the target path **only when reclaim safety checks pass** (see Requirement: Create-time reclaim SHALL share operator remove safety). When reclaim is refused, `createWorktree` SHALL abort without creating a new worktree and without destroying the existing worktree or branch. After a git worktree is successfully created, the pipeline SHALL: (1) write the `node_modules` staging exclusion to `.git/info/exclude` inside the worktree, (2) remove any pre-existing `node_modules` symlink at the worktree root and log the removal, and (3) execute the dependency install step (as specified in `worktree-dependency-install`) before control returns to the caller, so that every worktree is fully bootstrapped and runnable from the moment it is created.

#### Scenario: clean stale path is reclaimed
- **WHEN** a directory already exists at the target worktree path
- **AND** the candidate is a managed worktree (or path collision under the managed root) with a clean workdir and no local-only commits
- **THEN** it SHALL be removed before the new worktree is created off `origin/<base_branch>`

#### Scenario: dirty stale path is not force-reclaimed
- **WHEN** a managed worktree already exists for the same issue (or at the target path)
- **AND** `git status --porcelain` in that worktree returns non-empty output
- **THEN** `createWorktree` SHALL NOT remove the worktree or delete its local branch
- **AND** SHALL abort with an error naming the dirty condition
- **AND** no new worktree SHALL be created at the target path for this call

#### Scenario: node_modules local exclude written during bootstrap
- **WHEN** a worktree is freshly created for an issue
- **THEN** the pipeline SHALL write the pattern `node_modules` to `.git/info/exclude` inside the worktree before any stage or harness runs
- **AND** subsequent `git add` commands in that worktree SHALL not stage any `node_modules` entry

#### Scenario: pre-existing node_modules symlink removed during bootstrap
- **WHEN** a `node_modules` symlink exists at the worktree root at bootstrap time (e.g., left by a prior aborted run)
- **THEN** the pipeline SHALL remove the symlink via `fs.unlink` and emit a log message identifying the removed path
- **AND** the symlink SHALL NOT be present when the dependency install step or any harness runs

#### Scenario: node_modules directory is not removed during bootstrap
- **WHEN** a `node_modules` directory (not a symlink) exists at the worktree root at bootstrap time
- **THEN** the pipeline SHALL NOT remove it
- **AND** SHALL treat it as a legitimately-installed dependency tree and skip the install step per the idempotency rule in `worktree-dependency-install`

#### Scenario: worktree is dependency-installed before first use
- **WHEN** a worktree is freshly created for an issue
- **THEN** the dependency install step SHALL run inside that worktree before `createWorktree` returns
- **AND** all subsequent stages SHALL be able to invoke binaries that the install step provides

## ADDED Requirements

### Requirement: Create-time reclaim SHALL share operator remove safety
Before `createWorktree` destroys any same-issue managed worktree (retry, title/slug change, multi-stale accumulation) or clears a colliding path at the computed target, the pipeline SHALL apply the same safety policy as `removeWorktreeForIssue` / `worktree-per-run-removal` **without force**: (1) when the path is on disk, treat a dirty workdir as blocking; (2) evaluate local-only (unpushed) commits with the same tier results (`true` / `"unverifiable"` / `null` / clean); (3) refuse reclaim on any blocking result and leave the worktree and local branch intact. Reclaim SHALL NOT pass an implicit force flag that discards dirty work or bypasses local-only verification failure. Clean candidates with no local-only commits MAY be removed so create can proceed. Records with `underManagedRoot === false` SHALL continue to be skipped (never force-reclaimed). The safety policy SHALL be single-sourced with operator remove so the two paths cannot silently diverge.

#### Scenario: Dirty managed worktree blocks reclaim on retry
- **WHEN** issue N already has a managed active worktree with uncommitted changes
- **AND** `createWorktree` runs again for issue N (retry / re-run)
- **THEN** the pipeline SHALL NOT invoke `git worktree remove` or `git branch -D` for that worktree
- **AND** `createWorktree` SHALL fail with an error that identifies the dirty condition and the issue or path
- **AND** the existing worktree directory and branch SHALL remain

#### Scenario: Local-only commits block reclaim on slug change
- **WHEN** issue N has a managed worktree on branch `pipeline/N-<old-slug>` with commits not pushed to the remote
- **AND** the issue title changes so the new slug differs
- **AND** `createWorktree` runs for issue N with the new slug
- **THEN** reclaim of the old-slug worktree SHALL be refused
- **AND** no `git worktree remove` / `git branch -D` SHALL run for that branch
- **AND** `createWorktree` SHALL fail with an error naming the local-only condition

#### Scenario: Unverifiable local-only state blocks reclaim
- **WHEN** local-only commit verification for a reclaim candidate returns `"unverifiable"` (or a hard verification failure / `null`)
- **THEN** reclaim SHALL refuse without mutating the worktree or branch
- **AND** `createWorktree` SHALL fail with an error naming the verification condition

#### Scenario: Clean managed worktree is reclaimed so create proceeds
- **WHEN** issue N has a managed active worktree that is clean and has no local-only commits
- **AND** `createWorktree` runs for issue N
- **THEN** the pipeline MAY remove that worktree and its local branch
- **AND** SHALL create a fresh worktree off `origin/<base_branch>` at the current slug path

#### Scenario: Out-of-managed-root worktree is never reclaimed
- **WHEN** a Git-registered worktree shares issue N's pipeline branch name but has `underManagedRoot === false`
- **AND** `createWorktree` runs for issue N
- **THEN** that worktree SHALL NOT be removed or branch-deleted by reclaim

#### Scenario: Safety policy is shared with operator remove
- **WHEN** the dirty or local-only tier outcomes are defined for `removeWorktreeForIssue`
- **THEN** create-time reclaim SHALL apply the same blocking outcomes as operator remove without `--force`
- **AND** a unit test suite SHALL fail if reclaim can call the destructive remove seam while dirty or local-only checks would block
