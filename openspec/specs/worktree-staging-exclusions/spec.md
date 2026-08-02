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
After any harness step (implement, fix round, test-fix) produces commits in `headBefore..HEAD`, the pipeline SHALL scan every commit in that range for tree entries whose path contains a `node_modules` path segment at **any** nesting depth (equivalent to matching `/(^|\/)node_modules(\/|$)/` on forward-slash git paths — e.g. `node_modules`, `node_modules/foo`, or `apps/web/node_modules/.pnpm/...`). If any such added entry is found, the pipeline SHALL block the step with a diagnostic identifying the offending commit SHA and path. The scan SHALL NOT treat a path as a hit solely because the substring `node_modules` appears inside a longer path component (e.g. `node_modules_backup` is not a match).

#### Scenario: Harness commit contains node_modules symlink — step blocks
- **WHEN** the implement harness exits 0 and one or more commits exist in `headBefore..HEAD`
- **AND** at least one commit adds a path whose first path component is `node_modules` (e.g., `node_modules` itself or `node_modules/foo`)
- **THEN** the pipeline SHALL block the step with reason: `"Commit <sha> adds a node_modules entry (<path>); node_modules must not be committed"`
- **AND** SHALL NOT push or advance to the next stage

#### Scenario: Harness commit contains a nested monorepo node_modules path — step blocks
- **WHEN** the implement harness exits 0 and one or more commits exist in `headBefore..HEAD`
- **AND** at least one commit adds a path with a non-leading `node_modules` segment (e.g. `apps/web/node_modules/.pnpm/lodash@4/index.js`)
- **THEN** the pipeline SHALL block the step with reason: `"Commit <sha> adds a node_modules entry (<path>); node_modules must not be committed"`
- **AND** the reason SHALL include the nested path
- **AND** SHALL NOT push or advance to the next stage

#### Scenario: Harness commit contains no node_modules entries — scan passes
- **WHEN** the implement harness exits 0 and one or more commits exist in `headBefore..HEAD`
- **AND** no commit in the range adds any path containing a `node_modules` path segment
- **THEN** the scan SHALL pass without blocking and the step SHALL proceed normally

#### Scenario: Path with node_modules as a substring of a component — scan passes
- **WHEN** the implement harness exits 0 and one or more commits exist in `headBefore..HEAD`
- **AND** a commit adds a path such as `docs/avoiding-node_modules.md` or `src/node_modules_backup/index.ts` where no full path component equals `node_modules`
- **THEN** the node_modules scan SHALL pass without blocking on that path

#### Scenario: Fix-round commit contains node_modules entry — step blocks
- **WHEN** a fix-round harness exits 0 and new commits are in `headBefore..HEAD`
- **AND** at least one commit adds a path containing a `node_modules` path segment at any depth
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

### Requirement: Nested monorepo node_modules post-commit scan has a regression test
The test suite SHALL include at least one unit test that drives `verifyHarnessCommits` with an injectable commit-file list containing a **nested** monorepo `node_modules` path (not only a worktree-root entry) and asserts the scan blocks. The test SHALL bite: under the legacy root-only check (`file.split("/")[0] === "node_modules"`), the same nested path SHALL NOT be treated as a hit, so the segment-aware check is load-bearing.

#### Scenario: Nested path blocks under segment-aware check and would pass root-only check
- **WHEN** a fake `gitDiffTreeFiles` returns a path such as `apps/web/node_modules/.pnpm/lodash@4/index.js` for a commit in range
- **AND** `verifyHarnessCommits` runs the node_modules scan
- **THEN** the result SHALL be `ok: false` with a reason that includes `node_modules` and the nested path
- **AND** the test SHALL demonstrate that the legacy root-only leading-component check would not flag that path

#### Scenario: Root-level node_modules cases remain blocked
- **WHEN** a fake `gitDiffTreeFiles` returns `node_modules` or `node_modules/some-pkg/index.js`
- **AND** `verifyHarnessCommits` runs the node_modules scan
- **THEN** the result SHALL remain `ok: false` (no regression of the #180 root-level cases)

### Requirement: Staging exclusions for attempt markers remain defense-in-depth after writer retirement

Salvage staging SHALL retain the depth-agnostic exclusion pathspec for residual
`.pipeline-rebase-attempted` (and any single-sourced pipeline-internal marker list) after the engine
stops writing that path as attempt authority, so leftover dirt cannot enter salvage commits. New
attempt authority SHALL NOT be introduced as an additional worktree-local marker file requiring a
new exclusion.

#### Scenario: Exclusion retained for residual marker path

- **WHEN** salvage stages uncommitted changes
- **THEN** `git add` args SHALL still include `:(exclude,glob)**/.pipeline-rebase-attempted` while
  that path remains in the canonical pipeline-internal marker list
- **AND** no new worktree-local attempt-marker path SHALL be added as production attempt authority

