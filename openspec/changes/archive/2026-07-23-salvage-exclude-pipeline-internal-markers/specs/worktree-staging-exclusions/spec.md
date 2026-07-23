## ADDED Requirements

### Requirement: Salvage staging excludes pipeline-internal marker files via explicit pathspec

When the salvage path stages uncommitted changes with `git add`, the staging command SHALL
carry an explicit **depth-agnostic** exclusion pathspec for pipeline-internal marker files
(`:(exclude,glob)**/.pipeline-rebase-attempted`), alongside the existing depth-agnostic
`node_modules` exclusion, so a pipeline-internal marker file is never included in a salvage
commit. This exclusion SHALL apply to both the unscoped default staging args and the scoped
(`openspec/`) staging args. Because a pipeline-internal marker file is not gitignored, the
salvage dirtiness check (`git status --porcelain`) SHALL likewise exclude the marker so that
a worktree whose only dirty path is the marker is treated as clean rather than committed.

#### Scenario: Salvage with a rebase marker present alongside real files — marker not staged

- **WHEN** the salvage path runs in a worktree containing `.pipeline-rebase-attempted`
- **AND** other modified files are also present
- **THEN** the salvage commit SHALL include the other modified files
- **AND** the salvage `git add` args SHALL include `:(exclude,glob)**/.pipeline-rebase-attempted`
- **AND** the salvage commit SHALL NOT include `.pipeline-rebase-attempted`

#### Scenario: Salvage with only a rebase marker present — nothing staged, no commit

- **WHEN** the salvage path runs in a worktree whose only dirty path is
  `.pipeline-rebase-attempted`
- **THEN** the salvage dirtiness check SHALL treat the worktree as clean
- **AND** the salvage SHALL create no commit and stage nothing (`gitAddAll` and `gitCommit`
  SHALL NOT be called)

#### Scenario: Scoped salvage staging carries both node_modules and marker exclusions

- **WHEN** the salvage path runs with the `openspec/` scope
- **THEN** the scoped `git add` args SHALL include the depth-agnostic `node_modules`
  exclusion AND `:(exclude,glob)**/.pipeline-rebase-attempted`
- **AND** SHALL restrict staging to `openspec/` as before

### Requirement: The marker-exclusion invariant has a regression test

The test suite SHALL include at least one test where the worktree mock's only dirty path is
`.pipeline-rebase-attempted` and the salvage path stages and commits nothing. The test SHALL
bite: with the marker exclusion removed from the salvage dirtiness check, the same worktree
SHALL produce a salvage commit that stages the marker.

#### Scenario: Marker-only salvage regression test bites

- **WHEN** the fake `gitStatus` returns a porcelain line for `.pipeline-rebase-attempted`
  as the only dirty entry
- **AND** the salvage path runs
- **THEN** the test SHALL assert no salvage commit is produced (`gitAddAll`/`gitCommit` not
  called, result `{ salvaged: false }`)
- **AND** SHALL assert that removing the marker exclusion from the dirtiness check makes the
  same test produce a salvage commit whose staged content is the marker
