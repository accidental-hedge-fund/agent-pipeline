## ADDED Requirements

### Requirement: Plan revision SHALL salvage uncommitted OpenSpec work before revalidate or block

The plan-revision path SHALL salvage uncommitted `openspec/` changes with the existing scoped salvage helper (`salvageIfNoNewCommit` with scope `openspec/`) after a successful plan-revision harness invocation when HEAD did not advance relative to the HEAD captured immediately before that invocation. That salvage SHALL run immediately after that successful process exit, before acknowledgement validation for that output, before re-validating the change, before any plan-review block, and therefore before park-release can treat the worktree as a clean remote-tip candidate. Salvage SHALL reuse that helper and SHALL NOT introduce a new salvage engine. Plan revision SHALL NOT migrate onto the shared harness-round helper solely to obtain salvage. The salvage SHALL stage only `openspec/` paths (parity with OpenSpec authoring). Implement, fix-round, and test-fix salvage call sites SHALL remain unscoped. When `openspec/` is clean after revision, the pipeline SHALL NOT create a salvage commit and SHALL continue to the existing revalidate or block path. A failed salvage attempt SHALL NOT skip the subsequent revalidate or block; it SHALL only preserve or disclose the uncommitted work as specified below.

#### Scenario: Dirty openspec/ after successful plan revision — salvaged before revalidate

- **WHEN** the plan-revision harness exits 0
- **AND** `headAfter === headBefore` relative to the HEAD captured immediately before that invoke
- **AND** the worktree contains uncommitted changes under `openspec/`
- **THEN** the pipeline SHALL create a salvage commit scoped to `openspec/`
- **AND** SHALL run that salvage before re-validating the OpenSpec change
- **AND** SHALL run that salvage before `setBlocked` or park-release for this plan-review step

#### Scenario: Initial invoke salvages even when acknowledgement later retries

- **WHEN** the initial plan-revision harness exits 0
- **AND** the acknowledgement contract later fails and triggers format repair
- **THEN** the pipeline SHALL attempt `openspec/`-scoped salvage immediately after that initial successful process exit
- **AND** SHALL do so before the format-repair retry invoke

#### Scenario: Format-repair retry also salvages openspec/ against that retry's HEAD

- **WHEN** the plan-revision acknowledgement contract fails and the shared format-repair retry invoke exits 0
- **AND** `headAfter === headBefore` relative to the HEAD captured immediately before that retry invoke
- **AND** the worktree contains uncommitted changes under `openspec/`
- **THEN** the pipeline SHALL attempt the same `openspec/`-scoped salvage after that successful retry
- **AND** SHALL do so before revalidate or the contract-exhausted block

#### Scenario: Retry salvage is not skipped after an initial salvage commit

- **WHEN** the initial plan-revision salvage creates a commit and HEAD advances
- **AND** the format-repair retry invoke then exits 0 with new uncommitted `openspec/` changes
- **THEN** the pipeline SHALL capture a new comparison HEAD immediately before that retry
- **AND** SHALL attempt `openspec/`-scoped salvage for those retry leftovers
- **AND** SHALL NOT compare the retry only against the pre-initial HEAD

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

The pipeline SHALL persist the captured salvage `failureReason` from `salvageIfNoNewCommit` / `trySalvageUncommittedWork` and SHALL include it in every subsequent plan-review blocker comment when plan revision attempted salvage and the salvage git operation failed. The pipeline SHALL NOT infer salvage success from a later clean worktree status. The pipeline SHALL NOT overwrite an earlier salvage failure reason with a later generic ack, claims, or revalidate blocker. Park-release SHALL NOT be the first signal that a revision existed. When salvage was not attempted because `openspec/` was clean, or when a later salvage on this step succeeded, the blocker comment SHALL follow the existing revalidate, acknowledgement, or claims failure wording without a salvage-failure section. When salvage failed and revalidation plus human-feedback acknowledgement otherwise succeed, the plan-review outcome SHALL still block and disclose the salvage failure; the pipeline SHALL NOT advance to implementing and SHALL NOT park-release dirty OpenSpec work as if no revision existed.

#### Scenario: Salvage git fails — reason named on the blocker

- **WHEN** plan revision attempts `openspec/`-scoped salvage for a dirty in-scope worktree
- **AND** the salvage git operation fails
- **AND** the pipeline then blocks at plan-review (for example revalidate fails or the acknowledgement contract is exhausted)
- **THEN** the blocker comment SHALL include the captured salvage failure reason
- **AND** SHALL NOT report only the revalidate or contract failure with no salvage detail

#### Scenario: Salvage git fails on initial invoke — reason survives format-repair retry block

- **WHEN** the initial plan-revision salvage attempt fails with a `failureReason`
- **AND** the acknowledgement contract then exhausts after format repair
- **THEN** the contract-exhausted blocker comment SHALL include that captured salvage failure reason

#### Scenario: Salvage git fails — revalidate success still blocks

- **WHEN** plan revision attempts `openspec/`-scoped salvage and the salvage git operation fails
- **AND** `revalidateArtifact` then returns ok
- **THEN** the pipeline SHALL still block at plan-review
- **AND** SHALL disclose the captured salvage failure reason
- **AND** SHALL NOT advance to implementing
- **AND** SHALL NOT treat the worktree as a clean remote-tip park-release candidate

#### Scenario: Clean in-scope worktree — blocker wording unchanged

- **WHEN** plan revision finds no in-scope uncommitted `openspec/` changes, so salvage is not attempted
- **AND** the pipeline then blocks (for example the change is invalid after revision)
- **THEN** the blocker comment SHALL NOT include a salvage-failure section

### Requirement: Plan-revision salvage SHALL have a biting regression test

The test suite SHALL include unit tests in `core/test/planning.test.ts` that inject git and salvage seams and SHALL NOT invoke a real git, network, or harness subprocess. Tests SHALL record an event log of HEAD capture, salvage, revalidate, and `setBlocked` so ordering is asserted by event index, not only by “salvage was eventually called”. The tests SHALL bite: with the salvage call removed, the same inputs SHALL return blocked without attempting salvage.

#### Scenario: Regression fails if revision returns blocked with dirty openspec/ and no salvage

- **WHEN** the fake plan-revision harness exits 0 with `headAfter === headBefore`
- **AND** the fake salvage seam records whether it was called and with which scope
- **AND** post-revision validation returns a block
- **THEN** the test SHALL assert salvage was called with scope `openspec/` before the blocked outcome
- **AND** SHALL assert that removing the salvage call makes the same inputs return blocked without salvage

#### Scenario: Event log proves initial-invoke salvage before revalidate and block

- **WHEN** the initial plan-revision invoke exits 0 with dirty `openspec/` and no new commit
- **AND** revalidate then returns a block
- **THEN** the test event log SHALL show salvage with scope `openspec/` at an earlier index than revalidate
- **AND** SHALL show revalidate at an earlier index than `setBlocked`

#### Scenario: Event log proves retry salvage before revalidate or contract-exhausted block

- **WHEN** the initial acknowledgement contract fails
- **AND** the format-repair retry invoke exits 0 with dirty `openspec/` and no new commit relative to the retry HEAD
- **THEN** the test event log SHALL show a salvage attempt after that retry invoke
- **AND** SHALL show that salvage at an earlier index than revalidate or the contract-exhausted `setBlocked`

#### Scenario: Retry salvage still runs after initial salvage advances HEAD

- **WHEN** the fake initial salvage returns `salvaged: true` and the fake HEAD then changes
- **AND** the format-repair retry exits 0 with new dirty `openspec/` work relative to the post-initial HEAD
- **THEN** the test SHALL assert a second salvage attempt with scope `openspec/`
- **AND** SHALL fail if retry salvage compared only against the pre-initial HEAD and skipped

#### Scenario: Unit test uses injected seams only

- **WHEN** the plan-revision salvage regression runs
- **THEN** it SHALL use the existing planning git and salvage dependency seams
- **AND** SHALL NOT spawn a real git, network, or harness process
