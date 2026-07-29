## MODIFIED Requirements

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

## ADDED Requirements

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
