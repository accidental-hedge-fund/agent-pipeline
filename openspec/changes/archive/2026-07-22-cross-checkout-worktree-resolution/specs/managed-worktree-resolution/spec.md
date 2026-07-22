# managed-worktree-resolution

## ADDED Requirements

### Requirement: Managed worktree roots SHALL be derived from Git's registered worktree set
The pipeline SHALL resolve the set of pipeline-managed worktree roots from `git worktree list --porcelain` output: for every registered checkout `W` in that listing, `path.resolve(W, cfg.worktree_root)` SHALL be a managed root. The resulting set SHALL be de-duplicated and SHALL NOT depend on which checkout is `cfg.repo_dir`, so two linked checkouts of the same Git common directory resolve the identical set. A single-checkout repository SHALL resolve to exactly one root, identical to the pre-existing main-worktree-derived root.

#### Scenario: Every registered checkout contributes a root
- **WHEN** the porcelain listing registers a main checkout `/repo` and a linked checkout `/orchestration`
- **AND** `cfg.worktree_root` is `.worktrees`
- **THEN** the resolved root set SHALL be `{/repo/.worktrees, /orchestration/.worktrees}`

#### Scenario: The set is independent of the invoking checkout
- **WHEN** the same porcelain listing is resolved once with `cfg.repo_dir` set to `/repo` and once with `cfg.repo_dir` set to `/orchestration`
- **THEN** both resolutions SHALL produce the same root set

#### Scenario: Single-checkout repositories are unchanged
- **WHEN** the porcelain listing registers only the main checkout `/repo`
- **THEN** the resolved root set SHALL be exactly `{/repo/.worktrees}`

#### Scenario: An absolute worktree_root collapses to one root
- **WHEN** `cfg.worktree_root` is an absolute path and several checkouts are registered
- **THEN** the resolved root set SHALL contain that single absolute root once

---

### Requirement: Worktree records SHALL be classified as managed against the whole root set
`parseWorktreePorcelain` SHALL mark a record `underManagedRoot: true` when the record's parent directory equals any root in the resolved set, and `false` otherwise. The record identity rules SHALL be unchanged: a record is identified by its `pipeline/<N>-<slug>` branch when it is on that branch, and the `pipeline-<N>-<slug>` directory-name fallback SHALL remain restricted to records that carry no branch line in the porcelain output (detached HEAD).

#### Scenario: A worktree under a linked checkout's root is managed
- **WHEN** a worktree at `/orchestration/.worktrees/pipeline-7-fix-thing` on branch `pipeline/7-fix-thing` is registered
- **AND** `/orchestration/.worktrees` is in the resolved root set
- **THEN** its record SHALL carry `issueNumber: 7`, `slug: "fix-thing"`, and `underManagedRoot: true`

#### Scenario: A developer checkout of a pipeline branch outside every root is not managed
- **WHEN** a worktree at `/home/dev/scratch` on branch `pipeline/7-fix-thing` is registered
- **AND** `/home/dev/scratch`'s parent directory is not in the resolved root set
- **THEN** its record SHALL carry `underManagedRoot: false`

#### Scenario: Directory-name identity still requires a detached record
- **WHEN** a worktree at `<root>/pipeline-7-fix-thing` is registered on a non-pipeline branch such as `main`
- **THEN** it SHALL NOT be identified as issue 7's pipeline worktree

#### Scenario: Unregistered directories are never records
- **WHEN** a directory named `pipeline-7-fix-thing` exists under a managed root but is absent from `git worktree list --porcelain` output
- **THEN** no record SHALL be produced for it

---

### Requirement: All worktree listing callers SHALL share one resolution
`listOnDisk` SHALL compute the managed-root set from the porcelain output it already reads and pass it to the parser, and `getForIssue`, `getOnDiskForIssue`, and `sweepMergedWorktrees` SHALL consume that classification rather than recomputing a root from `cfg.repo_dir`. A pipeline worktree registered under any checkout's managed root SHALL therefore be classified identically by every caller. Sweep's existing preconditions (merged PR state, cleanliness) SHALL be unchanged.

#### Scenario: Lookup callers see a cross-checkout worktree
- **WHEN** a Pipeline worktree for issue 7 is registered under a linked checkout's root
- **AND** `getOnDiskForIssue(cfg, 7)` is called with `cfg.repo_dir` set to the primary checkout
- **THEN** it SHALL return that worktree's path and slug

#### Scenario: Sweep recognizes a cross-checkout worktree without weakening its gates
- **WHEN** sweep evaluates a Pipeline worktree registered under a linked checkout's root
- **THEN** it SHALL classify the worktree as managed
- **AND** it SHALL remove the worktree only if the same merged-PR and cleanliness preconditions it already applies are satisfied

---

### Requirement: Worktree creation placement SHALL be unchanged
Resolving managed worktrees across checkouts SHALL NOT change where new worktrees are created, and SHALL NOT relocate, move, or re-register any existing worktree. `createWorktree` SHALL continue to place issue N's worktree at `<cfg.repo_dir>/<cfg.worktree_root>/pipeline-<N>-<slug>`.

#### Scenario: Creation from a linked checkout still uses that checkout's root
- **WHEN** `createWorktree` runs with `cfg.repo_dir` set to a linked checkout `/orchestration`
- **THEN** the worktree SHALL be created at `/orchestration/<cfg.worktree_root>/pipeline-<N>-<slug>`

#### Scenario: Discovery does not move existing worktrees
- **WHEN** managed-root resolution discovers a worktree under a checkout other than `cfg.repo_dir`
- **THEN** no move, re-registration, or path rewrite of that worktree SHALL occur
