## ADDED Requirements

### Requirement: Dirty-worktree block SHALL name the offending paths

The test/build gate's dirty-worktree block `blockReason` SHALL include the offending paths from
`git status --porcelain`, so the operator can see what is dirty without inspecting the worktree.
This applies to both dirty-tree blocks: the pre-run block (uncommitted changes before the first
trusted run) and the post-run block (a passing run that left the tree dirty). The porcelain path
list SHALL be appended to the existing human-readable reason under a short label (e.g.
`Uncommitted paths:`), and SHALL be truncated via the gate's existing output-cap helper when the
list is long so it cannot blow up the GitHub blocker comment. When the gate does not block on a
dirty tree, the reason SHALL be unchanged. The path-capture seam SHALL be injectable so the path
list is unit-testable without invoking real git.

#### Scenario: dirty before the first run names the paths

- **WHEN** the worktree has uncommitted changes before the gate runs (e.g. an untracked
  `openspec/config.yaml`)
- **THEN** the gate SHALL block with attempts 0 and SHALL NOT invoke the fix harness
- **AND** the `blockReason` SHALL contain the offending path(s) from `git status --porcelain`
  (e.g. a line containing `openspec/config.yaml`)

#### Scenario: passing run leaves artifacts — block names the paths

- **WHEN** the test/build command exits 0 but leaves the tree dirty
- **THEN** the gate SHALL block rather than report success
- **AND** the `blockReason` SHALL contain the offending path(s) from `git status --porcelain`

#### Scenario: long porcelain output is truncated

- **WHEN** the dirty worktree contains a large number of uncommitted paths
- **THEN** the `blockReason` SHALL include the porcelain list truncated to the gate's output cap
- **AND** the truncation SHALL be marked (e.g. a truncation suffix) rather than silently dropped

#### Scenario: path capture is injectable for unit testing

- **WHEN** the gate runs with a fake porcelain-status seam returning a known dirty path list
- **THEN** the test SHALL assert the resulting `blockReason` contains those paths
- **AND** the test SHALL do no real git, network, or subprocess calls

#### Scenario: clean worktree is unaffected

- **WHEN** the worktree is clean before the run and the command passes leaving the tree clean
- **THEN** the gate SHALL pass and SHALL NOT add any porcelain-path text to its result
