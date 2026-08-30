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

The `PlanningPhaseHooks` interface SHALL declare exactly these hook points: authoring the planning
artifact, optional plan-revision invocation, post-author structural validation, post-revision
re-validation, and building the PR body and transition message. Validation hooks SHALL return a
typed artifact result containing exact bounded diagnostics rather than only prose. No other
lifecycle step SHALL vary between hook implementations. The optional revision hook SHALL run in the
issue worktree when present; when absent, the shared runner SHALL use `invokePlanStep`. After a
post-revision validation failure, the shared runner SHALL preserve and return the exact canonical
diagnostic as an engine-owned block. When invoked by a durable loop, the outer provider-neutral
recovery controller SHALL use that diagnostic and current candidate for bounded remediation, then
redispatch the whole item so the same validation hook runs again. The mechanical block SHALL not
imply human authority.

#### Scenario: Authoring hook produces the planning artifact

- **WHEN** `runPlanningPhases` reaches the authoring step
- **THEN** it SHALL call `hooks.authorArtifact`
- **AND** it SHALL use the returned artifact as plan content for later steps

#### Scenario: Validation hook gates progression

- **WHEN** `runPlanningPhases` calls a structural validation hook and it returns failure
- **THEN** the runner SHALL preserve the hook's exact typed diagnostic
- **AND** it SHALL not progress to implementation until validation succeeds

#### Scenario: Post-revision validation receives bounded artifact repair

- **WHEN** post-revision validation fails and an eligible keyed artifact-repair attempt remains
- **THEN** the shared runner SHALL return the exact engine-owned diagnostic without granting human
  authority
- **AND** the outer controller SHALL remediate and redispatch so the same validation hook runs
  against the repaired current candidate

#### Scenario: Exhausted post-revision validation remains engine-owned

- **WHEN** post-revision validation continues to fail after its keyed repair budget is exhausted
- **THEN** `runPlanningPhases` SHALL call `setBlocked` with the typed artifact diagnostic and return
  `{ advanced: false, status: "blocked" }`
- **AND** it SHALL not emit human-authority evidence solely for that failure

#### Scenario: OpenSpec revision hook runs in the issue worktree

- **WHEN** `runPlanningPhases` reaches plan revision and `hooks.invokeRevision` is present
- **THEN** it SHALL call `hooks.invokeRevision` with the issue worktree and delegate invocation to
  the hook
- **AND** the OpenSpec implementation SHALL run the revision harness in that worktree so it can
  update the change files in place

#### Scenario: Repair uses configured roles rather than a provider-specific hook

- **WHEN** the outer controller invokes artifact remediation for a planning diagnostic
- **THEN** the transaction SHALL resolve the configured implementer adapter, model, and effort
- **AND** `PlanningPhaseHooks` SHALL not add a provider-specific repair hook

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

### Requirement: The shared planning phase runner SHALL recompute planning facts immediately before each planning model invocation

`runPlanningPhases` SHALL invoke planning-facts observation immediately before plan authoring, immediately before plan-review, and immediately before plan-revision. Freeform and OpenSpec hooks SHALL share that observation. The runner SHALL pass the resulting current bundle into the prompt builder for that invocation. The runner SHALL NOT invoke the corresponding harness when a required provider failed that observation.

#### Scenario: Freeform planning observes before authoring

- **WHEN** `runPlanningPhases` reaches plan authoring on a repository that declares providers
- **THEN** it SHALL complete a fresh observation before `hooks.authorArtifact`
- **AND** the authoring prompt SHALL receive that observation's bundle

#### Scenario: OpenSpec planning uses the same observation seam

- **WHEN** `runPlanningPhases` reaches plan authoring on an OpenSpec repository that declares providers
- **THEN** it SHALL use the same observation function as the freeform path
- **AND** the OpenSpec planning prompt SHALL receive that observation's bundle

#### Scenario: Plan-review and plan-revision recompute

- **WHEN** the runner reaches plan-review or plan-revision
- **THEN** it SHALL recompute facts immediately before that harness invoke
- **AND** SHALL NOT reuse the authoring-time bundle as current

### Requirement: Planning-facts provider-contract failure SHALL be equivalent across freeform and OpenSpec paths

When planning-facts observation fails the provider contract, both freeform and OpenSpec paths SHALL record the same blocker tag `planning-facts-provider-contract` and the same reason prefix when routed through `runPlanningPhases`.

#### Scenario: Required provider failure is equivalent across paths

- **WHEN** a required provider times out or mutates the worktree
- **THEN** both freeform and OpenSpec hooks SHALL result in blocker tag `planning-facts-provider-contract`
- **AND** SHALL share the same reason prefix
- **AND** SHALL NOT invoke the model that observation was meant to feed
