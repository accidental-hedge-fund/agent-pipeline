## MODIFIED Requirements

### Requirement: Pipeline SHALL salvage uncommitted harness work before blocking on no-commit

When a harness step (implement, fix round, or test-fix) exits and the pipeline detects that no new commit was produced in the harness range but the worktree contains uncommitted changes, the pipeline SHALL stage all changes — excluding `node_modules` entries — and create a salvage commit in the worktree before proceeding, rather than blocking with "No commits found in the range".

#### Scenario: Dirty worktree after implement harness — salvage commit created and pipeline advances

- **WHEN** the implement harness exits and `headBefore === headAfter`
- **AND** `git status --porcelain` in the worktree returns non-empty output
- **THEN** the pipeline SHALL run `git add -A -- :(exclude)node_modules` followed by `git commit` with a salvage message in the worktree
- **AND** the commit message SHALL begin with `salvage: stage harness work (#<issueNumber>)`
- **AND** the commit message SHALL include `Issue: #<issueNumber>` and `Pipeline-Run: <pipelineRunId>` trailers
- **AND** the pipeline SHALL proceed to the test gate as if the harness had committed

#### Scenario: Dirty worktree after fix round — salvage commit created and pipeline advances

- **WHEN** a fix-round harness (round 1 or 2) exits and no new commit is detected
- **AND** the worktree contains uncommitted changes
- **THEN** the pipeline SHALL create a salvage commit using `git add -A -- :(exclude)node_modules` with the same subject prefix and trailers
- **AND** SHALL proceed to the downstream verification steps (test gate, format check) as normal

#### Scenario: Dirty worktree after test-fix harness — salvage commit created

- **WHEN** a test-fix harness exits and no new commit is detected
- **AND** the worktree contains uncommitted changes
- **THEN** the pipeline SHALL create a salvage commit using `git add -A -- :(exclude)node_modules` and proceed to re-run the test command

#### Scenario: Dirty worktree contains only node_modules changes — treated as clean

- **WHEN** a harness exits and no new commit was produced
- **AND** `git status --porcelain` reports changes only under `node_modules`
- **THEN** after the excluded staging, the worktree SHALL be effectively clean
- **AND** the pipeline SHALL follow the existing block / auto-recover path as if no uncommitted changes were present

#### Scenario: Clean worktree after harness — existing block path unchanged

- **WHEN** a harness step exits and no new commit was produced
- **AND** `git status --porcelain` in the worktree returns empty output (clean worktree)
- **THEN** the pipeline SHALL NOT attempt salvage
- **AND** SHALL follow the existing block / auto-recover path without modification
