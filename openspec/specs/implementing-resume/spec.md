# implementing-resume Specification

## Purpose
TBD - created by archiving change implementing-resume. Update Purpose after archive.
## Requirements
### Requirement: implementing stage is resumable when commits exist in the worktree

When the orchestrator dispatches stage `implementing` at the start of a run (re-entry, not mid-flight), it SHALL first consult the repo-stable live-planning marker for the issue. If a live process owns the marker, the dispatcher SHALL return a `waiting` outcome whose reason names the live concurrent owner. Otherwise it SHALL check whether an existing worktree for the issue has commits ahead of the base branch. If so, it SHALL resume the post-implementation steps — test gate → push → open-or-find PR → transition `implementing → review-1` — without re-planning or re-implementing. If no live process owns the marker AND no worktree with commits exists, the issue is crash-stranded and the dispatcher SHALL restart the planning arc from `ready` (see the crash-stranded recovery requirement) rather than returning `waiting`.

The liveness check SHALL run before the commits-ahead check so that a live cross-domain implementer is never resume-raced.

#### Scenario: re-entry with commits — advances to review-1

- **WHEN** a pipeline run starts with the current stage resolved as `implementing`
- **AND** no live process owns the repo-stable live-planning marker for the issue
- **AND** a worktree exists for the issue with at least one commit ahead of `cfg.base_branch`
- **AND** the issue does not carry the `blocked` label
- **THEN** the pipeline SHALL run the test gate, push the branch, create or find the PR, and transition the issue to `review-1`
- **AND** SHALL NOT re-invoke the planning or implementing harness

#### Scenario: re-entry with a live owner — returns waiting (no resume race)

- **WHEN** a pipeline run starts with the current stage resolved as `implementing`
- **AND** the repo-stable live-planning marker is present and its recorded PID is alive
- **THEN** the dispatcher SHALL return `{ advanced: false, status: "waiting" }`
- **AND** the `waiting` reason SHALL name the live concurrent owner rather than "nothing to do at this point"
- **AND** SHALL NOT inspect the worktree, resume post-implementation steps, roll back the label, or restart planning

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

### Requirement: crash-stranded implementing stage SHALL restart from ready

When the orchestrator dispatches stage `implementing` at the start of a run and finds that no live process owns the repo-stable live-planning marker AND no worktree with commits ahead of `cfg.base_branch` exists, the dispatcher SHALL treat the issue as crash-stranded. It SHALL roll the label back to `ready` via a `transition()` call, log a one-line recovery diagnostic, and restart the planning arc by calling `planningStage.advance()` — identical to the recovery taken for a stranded `planning` / `plan-review` entry. It SHALL NOT return a `waiting` "nothing to do" outcome and SHALL NOT leave the run as a 0-transition no-op.

The recovery diagnostic SHALL be `[pipeline] #N: recovered stranded implementing attempt — restarting from ready`, printed before the rollback.

Because the live-planning marker is set at the start of `planningStage.advance()` and cleared in a `finally` block covering the whole `ready → review-1` arc (planning, plan-review, and implementing), an absent-or-dead marker at the `implementing` entry proves the run that set `implementing` is no longer alive. The rollback and restart are therefore safe: no live process can be mid-implementation for this issue.

#### Scenario: crash-stranded implementing restarts without operator intervention

- **WHEN** a pipeline run starts with the current stage resolved as `implementing`
- **AND** the repo-stable live-planning marker is absent (or its recorded PID is dead)
- **AND** no worktree with commits ahead of `cfg.base_branch` exists for the issue
- **THEN** the dispatcher SHALL NOT return `{ advanced: false, status: "waiting" }`
- **AND** SHALL print `[pipeline] #N: recovered stranded implementing attempt — restarting from ready` before rolling back
- **AND** SHALL roll the issue back to `pipeline:ready` via a `transition()` call referencing the crash recovery
- **AND** SHALL invoke `planningStage.advance()` to restart the full planning arc

#### Scenario: recovery outcome is advancing, not waiting

- **WHEN** the dispatcher recovers a crash-stranded `implementing` issue and `planningStage.advance()` succeeds
- **THEN** the returned `Outcome` SHALL have `advanced: true`
- **AND** the run SHALL NOT be a 0-transition no-op that exits as if healthy

#### Scenario: liveness gate precedes the commits check

- **WHEN** the `implementing` dispatch runs
- **THEN** it SHALL evaluate the live-planning marker before inspecting the worktree for commits ahead of base
- **AND** a live owner SHALL short-circuit to `waiting` without any worktree inspection, rollback, or restart

