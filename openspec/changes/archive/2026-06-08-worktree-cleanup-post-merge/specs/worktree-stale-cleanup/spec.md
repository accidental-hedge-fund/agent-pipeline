## ADDED Requirements

### Requirement: Sweep merged-PR worktrees on demand
The pipeline SHALL provide an explicit `--cleanup` mode that scans all on-disk pipeline-managed worktrees, identifies those whose associated PR has been merged, and removes them. Cleanup SHALL be triggered only when the operator explicitly requests it — it SHALL NOT run automatically as a side-effect of normal `pipeline <N>` invocations.

#### Scenario: Cleanup runs when requested
- **WHEN** the operator invokes `pipeline --cleanup`
- **THEN** the pipeline scans all worktrees under `cfg.worktree_root` whose branch matches `pipeline/<N>-<slug>`
- **AND** for each worktree determines whether its PR is merged
- **AND** prints a report of removed and skipped worktrees before exiting zero

#### Scenario: No cleanup without explicit flag
- **WHEN** the operator invokes `pipeline <N>` (normal advance mode)
- **THEN** no sweep of other worktrees occurs
- **AND** the existing per-issue removal at `pipeline:ready-to-deploy` and during auto-recovery is unchanged

---

### Requirement: Remove merged-PR worktrees
For each pipeline-managed worktree on disk, if its associated PR is merged, the pipeline SHALL remove the worktree directory, deregister it from git, and delete the local branch. The remote branch SHALL NOT be touched.

#### Scenario: Worktree with merged PR is removed
- **WHEN** a worktree for branch `pipeline/<N>-<slug>` exists on disk
- **AND** a PR with head branch `pipeline/<N>-<slug>` has state `merged`
- **AND** the worktree has no uncommitted local changes
- **THEN** the worktree directory is removed from disk
- **AND** `git worktree list` no longer includes the worktree
- **AND** the local branch `pipeline/<N>-<slug>` is deleted
- **AND** the worktree is reported as removed in the cleanup output

#### Scenario: Open-PR worktree is untouched
- **WHEN** a worktree for branch `pipeline/<N>-<slug>` exists on disk
- **AND** no merged PR with that head branch exists
- **THEN** the worktree directory is NOT removed
- **AND** the local branch is NOT deleted
- **AND** the worktree does NOT appear in the removed list

---

### Requirement: Skip worktrees with uncommitted local changes
The pipeline SHALL NOT silently destroy uncommitted work. If a worktree with a merged PR has uncommitted local changes (tracked or untracked modifications), the cleanup SHALL skip that worktree and include it in the skipped list with reason `"uncommitted changes"`.

#### Scenario: Dirty worktree is skipped
- **WHEN** a worktree's PR is merged
- **AND** `git status --porcelain` in the worktree directory returns non-empty output
- **THEN** the worktree is NOT removed
- **AND** it appears in the skipped list with reason `"uncommitted changes"`

#### Scenario: Clean worktree with merged PR is removed
- **WHEN** a worktree's PR is merged
- **AND** `git status --porcelain` in the worktree directory returns empty output
- **THEN** the worktree is removed (see Requirement: Remove merged-PR worktrees)

---

### Requirement: Scope cleanup to pipeline-managed worktrees only
Cleanup SHALL only consider worktrees whose path is under `cfg.worktree_root` AND whose branch name matches the `pipeline/<N>-<slug>` convention. Worktrees outside the configured root or with non-pipeline branch names SHALL be completely ignored.

#### Scenario: Non-pipeline worktree is ignored
- **WHEN** `git worktree list` includes a worktree whose branch does NOT start with `pipeline/`
- **THEN** that worktree is not evaluated, removed, or reported

#### Scenario: Worktree outside configured root is ignored
- **WHEN** a worktree has a `pipeline/<N>-<slug>` branch but its path is outside `cfg.worktree_root`
- **THEN** that worktree is not evaluated, removed, or reported

---

### Requirement: Report removed and skipped items
After sweep, the pipeline SHALL print a human-readable summary listing: (a) each removed worktree with its branch name, and (b) each skipped worktree with its branch name and the skip reason. If no worktrees were removed or skipped, the output SHALL indicate that cleanup found nothing to do.

#### Scenario: Removed and skipped items are reported
- **WHEN** cleanup removes N worktrees and skips M worktrees
- **THEN** the output lists each removed worktree's branch name
- **AND** lists each skipped worktree's branch name and reason
- **AND** the process exits zero

#### Scenario: No stale worktrees found
- **WHEN** cleanup runs and finds no merged-PR worktrees
- **THEN** the output indicates no worktrees were removed
- **AND** the process exits zero

---

### Requirement: Cleanup is idempotent
Running `pipeline --cleanup` multiple times SHALL produce the same final state. After the first run removes all stale worktrees, subsequent runs SHALL find nothing to do and exit cleanly.

#### Scenario: Second cleanup run is a no-op
- **WHEN** `pipeline --cleanup` is run and removes all stale worktrees
- **AND** `pipeline --cleanup` is run again immediately
- **THEN** the second run removes zero worktrees and reports nothing to do
- **AND** the process exits zero
