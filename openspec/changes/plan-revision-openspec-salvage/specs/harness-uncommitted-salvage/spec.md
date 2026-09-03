## ADDED Requirements

### Requirement: Plan revision SHALL salvage uncommitted OpenSpec work before revalidate or block

The plan-revision path SHALL salvage uncommitted `openspec/` changes with the existing scoped salvage helper (`salvageIfNoNewCommit` with scope `openspec/`) after a successful plan-revision harness invocation when HEAD did not advance. That salvage SHALL run before re-validating the change, before any plan-review block, and therefore before park-release can treat the worktree as a clean remote-tip candidate. Salvage SHALL reuse that helper and SHALL NOT introduce a new salvage engine. Plan revision SHALL NOT migrate onto the shared harness-round helper solely to obtain salvage. The salvage SHALL stage only `openspec/` paths (parity with OpenSpec authoring). Implement, fix-round, and test-fix salvage call sites SHALL remain unscoped. When `openspec/` is clean after revision, the pipeline SHALL NOT create a salvage commit and SHALL continue to the existing revalidate or block path. A failed salvage attempt SHALL NOT skip the subsequent revalidate or block; it SHALL only preserve or disclose the uncommitted work as specified below.

#### Scenario: Dirty openspec/ after successful plan revision — salvaged before revalidate

- **WHEN** the plan-revision harness exits 0
- **AND** `headAfter === headBefore`
- **AND** the worktree contains uncommitted changes under `openspec/`
- **THEN** the pipeline SHALL create a salvage commit scoped to `openspec/`
- **AND** SHALL run that salvage before re-validating the OpenSpec change
- **AND** SHALL run that salvage before `setBlocked` or park-release for this plan-review step

#### Scenario: Format-repair retry also salvages openspec/

- **WHEN** the plan-revision acknowledgement contract fails and the shared format-repair retry invoke exits 0
- **AND** `headAfter === headBefore` relative to the HEAD captured before the first plan-revision invoke
- **AND** the worktree contains uncommitted changes under `openspec/`
- **THEN** the pipeline SHALL attempt the same `openspec/`-scoped salvage after that successful retry
- **AND** SHALL do so before revalidate or the contract-exhausted block

#### Scenario: Out-of-scope dirt is not committed by plan-revision salvage

- **WHEN** plan-revision salvage runs with scope `openspec/`
- **AND** the worktree contains an uncommitted `openspec/` change AND a modified file outside `openspec/` (for example `tasks/todo.md`)
- **THEN** the salvage commit SHALL contain only `openspec/` files
- **AND** the out-of-scope file SHALL remain uncommitted in the worktree, not discarded

#### Scenario: Clean openspec/ after revision — existing revalidate or block unchanged

- **WHEN** the plan-revision harness exits 0
- **AND** there are no uncommitted changes under `openspec/`
- **THEN** the pipeline SHALL NOT create a salvage commit
- **AND** SHALL continue to the existing revalidate or block path

#### Scenario: Implement and fix salvage stay unscoped

- **WHEN** implement, fix-round, or test-fix salvage runs after this change
- **THEN** those call sites SHALL pass no staging scope
- **AND** SHALL continue to stage the whole worktree minus `node_modules` and pipeline-internal markers

### Requirement: A failed plan-revision salvage SHALL be named on the plan-review blocker

The pipeline SHALL include the captured salvage failure reason in the subsequent plan-review blocker comment when plan revision attempts salvage and the salvage git operation fails. Park-release SHALL NOT be the first signal that a revision existed. When salvage was not attempted because `openspec/` was clean, or when salvage succeeded, the blocker comment SHALL follow the existing revalidate, acknowledgement, or claims failure wording without a salvage-failure section.

#### Scenario: Salvage git fails — reason named on the blocker

- **WHEN** plan revision attempts `openspec/`-scoped salvage for a dirty in-scope worktree
- **AND** the salvage git operation fails
- **AND** the pipeline then blocks at plan-review (for example revalidate fails or the acknowledgement contract is exhausted)
- **THEN** the blocker comment SHALL include the captured salvage failure reason
- **AND** SHALL NOT report only the revalidate or contract failure with no salvage detail

#### Scenario: Clean in-scope worktree — blocker wording unchanged

- **WHEN** plan revision finds no in-scope uncommitted `openspec/` changes, so salvage is not attempted
- **AND** the pipeline then blocks (for example the change is invalid after revision)
- **THEN** the blocker comment SHALL NOT include a salvage-failure section

### Requirement: Plan-revision salvage SHALL have a biting regression test

The test suite SHALL include a unit test in which a successful plan-revision harness leaves `openspec/` dirty with no new commit and the stage returns blocked (for example post-revision validation fails). The test SHALL assert that salvage is attempted with scope `openspec/` before that blocked return. The test SHALL inject git and salvage seams and SHALL NOT invoke a real git, network, or harness subprocess. The test SHALL bite: with the salvage call removed, the same inputs SHALL return blocked without attempting salvage.

#### Scenario: Regression fails if revision returns blocked with dirty openspec/ and no salvage

- **WHEN** the fake plan-revision harness exits 0 with `headAfter === headBefore`
- **AND** the fake salvage seam records whether it was called and with which scope
- **AND** post-revision validation returns a block
- **THEN** the test SHALL assert salvage was called with scope `openspec/` before the blocked outcome
- **AND** SHALL assert that removing the salvage call makes the same inputs return blocked without salvage

#### Scenario: Unit test uses injected seams only

- **WHEN** the plan-revision salvage regression runs
- **THEN** it SHALL use the existing planning git and salvage dependency seams
- **AND** SHALL NOT spawn a real git, network, or harness process
