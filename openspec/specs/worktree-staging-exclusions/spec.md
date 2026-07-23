# worktree-staging-exclusions Specification

## Purpose
TBD - created by archiving change no-node-modules-symlink-in-worktree-commits. Update Purpose after archive.
## Requirements
### Requirement: Worktree local exclude prevents node_modules from being staged
Immediately after a pipeline worktree is created and before any harness or stage runs, the pipeline SHALL write the pattern `node_modules` to `.git/info/exclude` inside that worktree. This causes `git add` — whether invoked by the harness or by the pipeline's salvage path — to ignore any `node_modules` entry (directory, symlink, or file) at the worktree root.

#### Scenario: node_modules directory is not staged after exclude is written
- **WHEN** the pipeline has written `node_modules` to `.git/info/exclude` in the worktree
- **AND** a `node_modules` directory exists at the worktree root
- **THEN** `git add -A` SHALL NOT stage any path under `node_modules`

#### Scenario: node_modules symlink is not staged after exclude is written
- **WHEN** the pipeline has written `node_modules` to `.git/info/exclude` in the worktree
- **AND** a `node_modules` symlink exists at the worktree root
- **THEN** `git add -A` SHALL NOT stage the `node_modules` symlink

#### Scenario: exclude file is created idempotently
- **WHEN** the exclude pattern is already present in `.git/info/exclude`
- **THEN** the bootstrap step SHALL NOT duplicate the entry
- **AND** the file SHALL remain valid

### Requirement: Post-commit scan blocks on node_modules entries in harness commits
After any harness step (implement, fix round, test-fix) produces commits in `headBefore..HEAD`, the pipeline SHALL scan every commit in that range for tree entries whose leading path component is `node_modules`. If any such entry is found, the pipeline SHALL block the step with a diagnostic identifying the offending commit SHA and path.

#### Scenario: Harness commit contains node_modules symlink — step blocks
- **WHEN** the implement harness exits 0 and one or more commits exist in `headBefore..HEAD`
- **AND** at least one commit adds a path whose first path component is `node_modules` (e.g., `node_modules` itself or `node_modules/foo`)
- **THEN** the pipeline SHALL block the step with reason: `"Commit <sha> adds a node_modules entry (<path>); node_modules must not be committed"`
- **AND** SHALL NOT push or advance to the next stage

#### Scenario: Harness commit contains no node_modules entries — scan passes
- **WHEN** the implement harness exits 0 and one or more commits exist in `headBefore..HEAD`
- **AND** no commit in the range adds any path whose first component is `node_modules`
- **THEN** the scan SHALL pass without blocking and the step SHALL proceed normally

#### Scenario: Fix-round commit contains node_modules entry — step blocks
- **WHEN** a fix-round harness exits 0 and new commits are in `headBefore..HEAD`
- **AND** at least one commit adds a `node_modules` entry
- **THEN** the pipeline SHALL block with an appropriate diagnostic

### Requirement: Salvage staging excludes node_modules via explicit pathspec
When the salvage path stages uncommitted changes with `git add`, the staging command SHALL use an explicit **depth-agnostic** exclusion pathspec (`:(exclude,glob)**/node_modules` and `:(exclude,glob)**/node_modules/**`) so that `node_modules` entries are never included in a salvage commit even if `.git/info/exclude` is absent or has not yet been written, and so that a `node_modules` entry at **any** nesting depth (not only the worktree root) is excluded. The exclusion SHALL cover a nested install such as `apps/web/node_modules/`, so the staging add does not fail on ignored nested paths in a monorepo.

#### Scenario: Salvage with node_modules symlink present — symlink not staged
- **WHEN** the salvage path runs in a worktree containing a `node_modules` symlink
- **AND** other modified files are also present
- **THEN** the salvage commit SHALL include the other modified files
- **AND** SHALL NOT include the `node_modules` symlink

#### Scenario: Salvage with node_modules directory present — directory not staged
- **WHEN** the salvage path runs in a worktree containing a `node_modules` directory with contents
- **AND** other modified files are also present
- **THEN** the salvage commit SHALL include the other modified files
- **AND** SHALL NOT include any path under `node_modules`

#### Scenario: Salvage with a nested node_modules install present — nested paths not staged and add does not fail
- **WHEN** the salvage path runs in a monorepo worktree containing a nested install at `apps/web/node_modules/` (for example `apps/web/node_modules/.pnpm/...`)
- **AND** other modified files outside `node_modules` are also present (for example `apps/web/src/foo.ts`)
- **THEN** the staging `git add` SHALL exclude the nested `apps/web/node_modules` paths and SHALL NOT exit non-zero because those ignored paths are enumerated
- **AND** the salvage commit SHALL include the other modified files
- **AND** SHALL NOT include any `node_modules` path at any depth

### Requirement: Each staging-exclusion invariant has a regression test
For each invariant introduced by this change, the test suite SHALL include at least one test where the worktree mock contains a `node_modules` entry and the pipeline does not stage or commit it. At least one such test SHALL use a **nested** `node_modules` entry (not only a worktree-root entry) and SHALL bite: with the exclusion narrowed back to the top-level-only `:(exclude)node_modules`, the nested entry SHALL no longer be excluded.

#### Scenario: Salvage test with node_modules in dirty worktree
- **WHEN** the fake `gitStatus` returns a porcelain line for a `node_modules` symlink alongside real changed files
- **AND** the salvage path runs
- **THEN** the test SHALL verify that `gitAddAll` is called with the depth-agnostic node_modules exclusion in its arguments
- **AND** the resulting commit message SHALL not reference `node_modules`

#### Scenario: Salvage regression test with a nested node_modules entry bites
- **WHEN** the fake `gitStatus` returns a porcelain line for a nested `apps/web/node_modules/.pnpm/...` entry alongside a real changed file
- **AND** the salvage path runs
- **THEN** the test SHALL assert `gitAddAll` is called with a pathspec that excludes `node_modules` at any depth
- **AND** SHALL assert that narrowing the exclusion to the top-level-only `:(exclude)node_modules` makes the same test fail (the nested entry would no longer be excluded)

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

