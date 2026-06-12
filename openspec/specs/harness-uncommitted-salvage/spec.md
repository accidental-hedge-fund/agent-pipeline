# harness-uncommitted-salvage Specification

## Purpose
TBD - created by archiving change recovery-salvage-uncommitted-harness-work. Update Purpose after archive.
## Requirements
### Requirement: Pipeline SHALL salvage uncommitted harness work before blocking on no-commit

When a harness step (implement, fix round, or test-fix) exits and the pipeline detects that no new commit was produced in the harness range but the worktree contains uncommitted changes, the pipeline SHALL stage all changes (`git add -A`) and create a salvage commit in the worktree before proceeding, rather than blocking with "No commits found in the range".

#### Scenario: Dirty worktree after implement harness — salvage commit created and pipeline advances

- **WHEN** the implement harness exits and `headBefore === headAfter`
- **AND** `git status --porcelain` in the worktree returns non-empty output
- **THEN** the pipeline SHALL run `git add -A` followed by `git commit` with a salvage message in the worktree
- **AND** the commit message SHALL begin with `salvage: stage harness work (#<issueNumber>)`
- **AND** the commit message SHALL include `Issue: #<issueNumber>` and `Pipeline-Run: <pipelineRunId>` trailers
- **AND** the pipeline SHALL proceed to the test gate as if the harness had committed

#### Scenario: Dirty worktree after fix round — salvage commit created and pipeline advances

- **WHEN** a fix-round harness (round 1 or 2) exits and no new commit is detected
- **AND** the worktree contains uncommitted changes
- **THEN** the pipeline SHALL create a salvage commit with the same subject prefix and trailers
- **AND** SHALL proceed to the downstream verification steps (test gate, format check) as normal

#### Scenario: Dirty worktree after test-fix harness — salvage commit created

- **WHEN** a test-fix harness exits and no new commit is detected
- **AND** the worktree contains uncommitted changes
- **THEN** the pipeline SHALL create a salvage commit and proceed to re-run the test command

#### Scenario: Clean worktree after harness — existing block path unchanged

- **WHEN** a harness step exits and no new commit was produced
- **AND** `git status --porcelain` in the worktree returns empty output (clean worktree)
- **THEN** the pipeline SHALL NOT attempt salvage
- **AND** SHALL follow the existing block / auto-recover path without modification

---

### Requirement: Salvage commit SHALL carry traceability trailers

Every commit created by the salvage path SHALL include the `Issue:` and `Pipeline-Run:` trailers required by the `commit-traceability-trailers` spec.

#### Scenario: Salvage commit has Issue and Pipeline-Run trailers

- **WHEN** the pipeline creates a salvage commit for issue N during a run with ID R
- **THEN** the commit message SHALL end with a blank line followed by `Issue: #N` and `Pipeline-Run: R` on separate lines

---

### Requirement: Salvage SHALL NOT bypass the test gate or any downstream verification

A salvaged commit advances the pipeline to the same post-commit verification path as a normally-committed harness result. A salvage commit that does not pass the test gate SHALL block the pipeline exactly as a normal failing commit would.

#### Scenario: Salvaged commit fails the test gate — pipeline blocks

- **WHEN** the pipeline creates a salvage commit and runs the test gate
- **AND** the test command exits non-zero
- **THEN** the pipeline SHALL block at the test gate with the test failure reason
- **AND** SHALL NOT advance to the next stage

#### Scenario: Salvaged commit passes the test gate — pipeline advances normally

- **WHEN** the pipeline creates a salvage commit and runs the test gate
- **AND** the test command exits 0
- **THEN** the pipeline SHALL advance to the next stage (e.g., PR creation or review) as normal

---

### Requirement: Salvage behavior SHALL be injectable for unit testing

The `salvageUncommittedWork` function SHALL accept a `SalvageDeps` parameter with injectable `gitStatus`, `gitAddAll`, and `gitCommit` seams. Unit tests SHALL use fake implementations of these seams and SHALL NOT invoke real git subprocesses.

#### Scenario: Unit test exercises dirty-worktree salvage path

- **WHEN** the fake `gitStatus` returns non-empty porcelain output
- **THEN** the test SHALL verify that fake `gitAddAll` and `gitCommit` are called with the correct arguments and message format

#### Scenario: Unit test exercises clean-worktree no-op path

- **WHEN** the fake `gitStatus` returns empty porcelain output
- **THEN** the test SHALL verify that neither `gitAddAll` nor `gitCommit` is called

