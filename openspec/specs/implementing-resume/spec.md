# implementing-resume Specification

## Purpose
TBD - created by archiving change implementing-resume. Update Purpose after archive.
## Requirements
### Requirement: implementing stage is resumable when commits exist in the worktree

When the orchestrator dispatches stage `implementing` at the start of a run (re-entry, not mid-flight), it SHALL check whether an existing worktree for the issue has commits ahead of the base branch. If so, it SHALL resume the post-implementation steps — test gate → push → open-or-find PR → transition `implementing → review-1` — without re-planning or re-implementing. If no worktree with commits exists, the dispatcher SHALL return the existing "nothing to do" waiting response.

#### Scenario: re-entry with commits — advances to review-1

- **WHEN** a pipeline run starts with the current stage resolved as `implementing`
- **AND** a worktree exists for the issue with at least one commit ahead of `cfg.base_branch`
- **AND** the issue does not carry the `blocked` label
- **THEN** the pipeline SHALL run the test gate, push the branch, create or find the PR, and transition the issue to `review-1`
- **AND** SHALL NOT re-invoke the planning or implementing harness

#### Scenario: re-entry with no commits — returns waiting (no regression)

- **WHEN** a pipeline run starts with the current stage resolved as `implementing`
- **AND** no worktree exists for the issue OR the worktree has no commits ahead of `cfg.base_branch`
- **THEN** the dispatcher SHALL return `{ advanced: false, status: "waiting" }` unchanged from today's behavior

#### Scenario: resume after unblock — test gate re-runs

- **WHEN** a prior run blocked at `implementing` due to a test-gate failure
- **AND** the operator has fixed the failing tests and committed to the worktree branch
- **AND** the operator runs `--unblock` followed by `/pipeline N`
- **THEN** the pipeline SHALL re-enter the resume path, re-run the test gate, and advance to `review-1` if the gate passes

#### Scenario: resume when gate still fails — re-blocks

- **WHEN** the pipeline resumes at `implementing` with commits in the worktree
- **AND** the test gate fails again on the resume attempt
- **THEN** the pipeline SHALL call `setBlocked` with kind `test-gate-exhausted` and SHALL NOT open a PR or transition the stage

### Requirement: PR is created exactly once across the initial run and any resume runs

When the pipeline resumes at `implementing`, it SHALL attempt to find an existing PR for the issue before creating a new one. If a PR already exists, it SHALL use the existing PR number and SHALL NOT attempt to create a duplicate. The transition comment (`implementing → review-1`) SHALL reference the PR number whether the PR was created in the current run or found from a prior partial run.

#### Scenario: PR already exists — reused on resume

- **WHEN** the resume path runs
- **AND** `getPrForIssue(cfg, issueNumber)` returns a PR number
- **THEN** the pipeline SHALL use that PR number for the transition comment
- **AND** SHALL NOT call `createPr()`

#### Scenario: no existing PR — created during resume

- **WHEN** the resume path runs
- **AND** `getPrForIssue(cfg, issueNumber)` returns null
- **THEN** the pipeline SHALL call `createPr()` and use the returned PR number for the transition comment

