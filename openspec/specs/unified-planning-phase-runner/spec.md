# unified-planning-phase-runner Specification

## Purpose
TBD - created by archiving change unify-freeform-openspec-planning. Update Purpose after archive.
## Requirements
### Requirement: A shared phase runner owns the planning lifecycle
The planning stage SHALL implement a `runPlanningPhases` internal function that encapsulates the full planning lifecycle — carry-forward context, worktree bootstrap, plan artifact authoring, stage transitions, plan review, human-feedback acknowledgement, plan revision, implementation, uncommitted-work salvage, commit verification, and post-implementation steps — parameterized by a `PlanningPhaseHooks` interface.

#### Scenario: freeform path routes through the shared runner
- **WHEN** `advance` is called on a repo without an OpenSpec workspace
- **THEN** it SHALL construct `FreefformPlanningHooks` and delegate to `runPlanningPhases`
- **AND** the observable behavior (transitions, blockers, comments, PR body) SHALL be identical to the pre-change freeform path

#### Scenario: OpenSpec path routes through the shared runner
- **WHEN** `advanceOpenspec` is called on a repo with an OpenSpec workspace
- **THEN** it SHALL construct `OpenspecPlanningHooks` and delegate to `runPlanningPhases`
- **AND** the observable behavior (transitions, blockers, comments, PR body) SHALL be identical to the pre-change OpenSpec path

### Requirement: Hook interface isolates the authoring and validation steps
The `PlanningPhaseHooks` interface SHALL declare exactly the following hook points: authoring the planning artifact, plan-revision invocation (optional), post-author structural validation, post-revision re-validation, and building the PR body and transition message. No other lifecycle step SHALL vary between hook implementations. The plan-revision hook (`invokeRevision`) is optional — when absent, the shared runner falls back to `invokePlanStep` (which uses `cfg.repo_dir` for non-sandboxed runs); when present, it allows the revision harness to run in the issue worktree.

#### Scenario: authoring hook produces the planning artifact
- **WHEN** `runPlanningPhases` reaches the authoring step
- **THEN** it SHALL call `hooks.authorArtifact` and use the returned artifact text as the plan content for subsequent steps

#### Scenario: validation hook gates progression
- **WHEN** `runPlanningPhases` calls `hooks.validateArtifact` (post-author or post-revision)
- **AND** the hook returns a failure
- **THEN** `runPlanningPhases` SHALL call `setBlocked` with the hook-supplied reason and return `{ advanced: false, status: "blocked" }`

#### Scenario: OpenSpec revision hook runs in the issue worktree
- **WHEN** `runPlanningPhases` reaches the plan-revision step
- **AND** `hooks.invokeRevision` is present
- **THEN** it SHALL call `hooks.invokeRevision` with the issue worktree and delegate invocation entirely to the hook
- **AND** the OpenSpec implementation SHALL run the revision harness in `wt.path` so it can update the OpenSpec change files in place

### Requirement: Paired blocker equivalence across paths
For every failure mode in the planning lifecycle — bootstrap failure, plan-generation failure, plan-review failure, plan-revision failure, human-feedback-ack failure, implementation harness failure, no-commits, and PR-creation failure — the freeform and OpenSpec hooks SHALL produce the same blocker `tag` value and the same reason prefix when routed through `runPlanningPhases`.

#### Scenario: bootstrap failure is equivalent across paths
- **WHEN** worktree creation or dependency installation fails
- **THEN** both `FreefformPlanningHooks` and `OpenspecPlanningHooks` SHALL result in the same blocker tag (`worktree-creation-failed` or `worktree-setup-failed`) and the same reason prefix

#### Scenario: plan-generation failure is equivalent across paths
- **WHEN** the authoring harness exits non-zero or times out
- **THEN** both hooks SHALL result in a blocker with tag `harness-failure` and a reason that includes the exit code or timeout duration

#### Scenario: plan-review failure is equivalent across paths
- **WHEN** the reviewer harness exits non-zero or times out during plan review
- **THEN** both paths SHALL result in a blocker with tag `harness-failure` on the `plan-review` stage

#### Scenario: human-feedback-ack failure is equivalent across paths
- **WHEN** the revised plan or proposal lacks the required human-feedback acknowledgement section
- **THEN** both paths SHALL result in a blocker with tag `needs-human` and a reason that references the missing section header

### Requirement: Existing exported functions and dep seams are preserved
The refactoring SHALL NOT change the signature of `advance`, `advanceOpenspec`, `bootstrapWorktree`, `resumeFromImplementing`, `dispatchResume`, `invokeImplementer`, `invokePlanStep`, or any other currently-exported function. Existing unit tests SHALL pass without modification.

#### Scenario: pre-existing tests pass unchanged
- **WHEN** the test suite runs after the refactoring
- **THEN** all tests that existed before this change SHALL pass without any modification to the test files

#### Scenario: dep injection seams are preserved
- **WHEN** a unit test injects a fake via `BootstrapWorktreeDeps`, `ImplementerInvokeDeps`, `PlanStepDeps`, or `ResumeFromImplementingDeps`
- **THEN** the fake SHALL be honoured by `runPlanningPhases` via the same parameter threading as before

