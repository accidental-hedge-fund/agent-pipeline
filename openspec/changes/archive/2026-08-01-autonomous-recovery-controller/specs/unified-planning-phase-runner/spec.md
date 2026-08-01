## MODIFIED Requirements

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
