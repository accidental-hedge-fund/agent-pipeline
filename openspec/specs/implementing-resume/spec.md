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

### Requirement: Post-implementation PR ensure disposes superseded open PRs

The post-implementation path SHALL, after creating or reusing the PR for issue N on the current managed head branch H (exact-head lookup, then create if missing), run supersede disposal for other open PRs associated with N whose head is not H, per the `supersede-issue-prs` capability, before treating ensure-PR as complete for the subsequent `implementing → review-1` transition. Exact-head reuse for H SHALL remain unchanged: when an open same-repo PR already exists for branch H, the path SHALL reuse that PR number and SHALL NOT create a duplicate PR for H. Supersede disposal SHALL run on both the create path and the reuse path so a stale associated PR on a different head is not left open solely because H already had a PR. When supersede disposal reports that the managed PR is **not** the GitHub-elected canonical open managed pipeline PR for N, the path SHALL NOT complete the stage transition as advanced and SHALL NOT treat ensure-PR as success for this concurrent head (so two hosts cannot both advance on PRs that close each other).

#### Scenario: New managed PR closes stale associated PR on other head

- **WHEN** the resume/post-implement path creates PR M for managed head H of issue N
- **AND** M is the GitHub-elected canonical open managed pipeline PR for N
- **AND** open PR S is associated with N under dual strategies on a different head
  with base `cfg.base_branch`
- **AND** supersede mode is `close` (default)
- **THEN** the path SHALL close S with a `pipeline-superseded` comment naming M
- **AND** SHALL proceed using M for the transition comment

#### Scenario: Reused managed PR still supersedes other heads

- **WHEN** the resume/post-implement path finds existing PR M for managed head H
- **AND** M is the GitHub-elected canonical open managed pipeline PR for N
- **AND** open PR S is associated with N on a different head with base `cfg.base_branch`
- **AND** supersede mode is `close` (default)
- **THEN** the path SHALL reuse M without calling create for H
- **AND** SHALL still dispose S under supersede rules

#### Scenario: Supersede failure does not prevent review-1 transition when managed PR is ready

- **WHEN** managed PR M for head H is successfully created or reused
- **AND** M is the GitHub-elected canonical open managed pipeline PR for N
- **AND** supersede disposal fails for a candidate S
- **THEN** the path SHALL still be allowed to complete ensure-PR and transition
  toward `review-1` with PR M
- **AND** SHALL surface a log/diagnostic for the disposal failure

#### Scenario: Non-canonical concurrent managed PR does not transition

- **WHEN** the resume/post-implement path ensures PR M for managed head H
- **AND** supersede disposal reports M is not the GitHub-elected canonical open
  managed pipeline PR for N (another concurrent `pipeline/<N>-*` head won)
- **THEN** the path SHALL NOT transition out of `implementing` as advanced
- **AND** SHALL NOT close the elected winning managed PR

#### Scenario: Externally closed managed PR does not transition or dispose siblings

- **WHEN** the resume/post-implement path ensures PR M for managed head H
- **AND** the authoritative open-PR list used by supersede disposal omits M on head H
  (for example a human closed M after ensure)
- **AND** another open associated PR S for issue N remains on a different head
- **THEN** the path SHALL NOT transition out of `implementing` as advanced
- **AND** SHALL NOT close or supersede-comment S

### Requirement: Implementing re-entry SHALL adopt an existing planning deliverable when the implement goal is already satisfied

When the pipeline re-enters the implementing stage or the implement phase of planning (including a **fresh process** re-entry, not only an in-memory helper call) and the accepted planning deliverable is already present at HEAD — for example a spec-only issue whose OpenSpec change under `openspec/changes/<id>/` landed in the planning commit — the path SHALL evaluate implement goal satisfaction via the shared `noop-advance-contract` (implement-deliverable-present). When the check reports satisfied, the worktree is clean relative to the implement headBefore, and relevant gates for the path are green, the pipeline SHALL advance through post-implement steps (test gate → push → open-or-find PR → transition toward review as already specified) **without** requiring an empty implementer commit and **without** blocking with `blockerKind: "no-commits"` solely for an empty implementer commit range. When the deliverable is missing or gates fail, the path SHALL fail closed (restart, block, or re-invoke implement per existing rules) and SHALL NOT skip implement solely because a prior harness “succeeded” with no commits.

#### Scenario: Spec-only planning commit deliverable advances without empty implement commit

- **WHEN** a fresh re-entry reaches implementing / implement with the accepted OpenSpec deliverable already present from the planning commit
- **AND** the implement harness produces no new commit (or is skipped because goal is already satisfied)
- **AND** the worktree is clean and relevant gates pass
- **THEN** the pipeline SHALL advance without inventing an empty commit
- **AND** SHALL NOT set `blockerKind: "no-commits"` solely for the empty implementer range
- **AND** SHALL record attested goal-satisfaction evidence at the evaluated HEAD SHA

#### Scenario: Missing deliverable still fails closed

- **WHEN** implementing / implement ends with no new commit and the declared OpenSpec or freeform deliverable is absent at HEAD
- **THEN** the shared evaluation SHALL not report implement-deliverable-present satisfaction
- **AND** the path SHALL block or recover under existing no-commits / crash-stranded rules rather than advancing as complete

