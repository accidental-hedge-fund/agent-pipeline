## Context

`core/scripts/stages/planning.ts` today contains two top-level exported functions — `advance` (freeform) and `advanceOpenspec` (OpenSpec) — that each individually implement an 8-step planning lifecycle. The two functions share ~70% of their logic: carry-forward context gathering, worktree bootstrap, stage transitions, plan-review and plan-revision (including human-feedback-ack and `verifyPlanRevisionOutput`), implementation harness invocation, uncommitted-work salvage, commit verification, and post-implementation steps.

The hooks that genuinely differ between the two paths are:
1. **Authoring**: freeform calls `invokePlanStep` and returns raw text; OpenSpec calls `invoke` targeting the OpenSpec workspace and validates the resulting change directory.
2. **Post-author validation**: freeform has none; OpenSpec calls `openspec.validateItem` and reads back spec deltas.
3. **Post-revision re-validation**: freeform has none; OpenSpec calls `openspec.validateItem` again and re-reads `readSpecDeltas`.
4. **PR body / transition message**: minor string differences (`## Revised Implementation Plan` vs. `_OpenSpec change …_`).

All other lifecycle steps are identical in intent, with only cosmetic differences in log messages.

## Goals / Non-Goals

**Goals:**
- Extract a parameterized `runPlanningPhases` internal function that owns the shared lifecycle.
- Define a `PlanningPhaseHooks` interface covering the two author + two validate hooks and the PR-body/transition-message customization.
- Implement `FreefformPlanningHooks` and `OpenspecPlanningHooks` as concrete hook objects.
- Keep `advance` and `advanceOpenspec` as thin public dispatch functions that delegate to `runPlanningPhases`.
- No observable behavior change on either path.
- All pre-existing tests pass without modification.

**Non-Goals:**
- Changing planning prompts, carry-forward, or review policy.
- Moving stage transitions or blocker codes — these stay identical to today.
- Introducing new config keys, flags, or external dependencies.
- Changing the pre-merge or post-implementation steps outside planning.ts.

## Decisions

### Decision: Hook interface rather than inheritance

**Chosen**: `PlanningPhaseHooks` as a plain object interface with function fields. The shared runner accepts the hooks object and calls into it at the two authoring steps and two validation steps.

**Alternatives considered**:
- Class hierarchy (`BasePlanning → FreefformPlanning / OpenspecPlanning`): more boilerplate, harder to test individual hooks in isolation, and the TypeScript class pattern is not established in this codebase.
- Inline conditional (`if (openspec) { … } else { … }` inside a single function): already the status quo; doesn't reduce duplication, just rearranges it.

**Rationale**: Function objects compose cleanly with the existing `deps` injection pattern used throughout `planning.ts` (`BootstrapWorktreeDeps`, `AdvanceReviewDeps`, etc.). Tests can fake individual hooks without constructing a full mock.

### Decision: `runPlanningPhases` is internal (not exported)

The shared runner is an implementation detail. Only `advance` and `advanceOpenspec` (already the exported API) remain exported. This keeps the public surface stable and lets the hook API evolve without a semver concern.

**Exception**: `PlanningPhaseHooks` and the two concrete implementations are exported for direct unit testing of the hook objects.

### Decision: PR body and transition message are hook fields

The two existing paths produce slightly different PR bodies (the OpenSpec path appends the change ID and `## Proposal` heading). Rather than a flag, the hooks supply a `buildPrBody` and `buildTransitionMessage` function, keeping the shared runner free of path-specific conditionals.

### Decision: No structural change to `resumeFromImplementing` or `dispatchResume`

Both are called at the end of `runPlanningPhases` through the same path today. The refactoring does not touch them.

## Risks / Trade-offs

- **Risk: hidden behavioral divergence** — the two parallel paths may have subtle differences not caught by the initial audit. Mitigation: paired unit tests for every failure mode (bootstrap, plan-gen, plan-review, plan-revision, human-feedback-ack, implementation, no-commits, PR creation) prove equivalent blocker tags and reason prefixes before merging.
- **Risk: test churn** — existing unit tests mock `invokePlanStep`, `invoke`, `openspec.*` etc. at the module level. The refactoring must not break those seams. Mitigation: keep the same exported function names and `deps` injection points; the shared runner accepts a `deps` parameter that threads through to the existing seams.

## Open Questions

None — the hook boundary is well-defined by the existing code. The implementation can proceed directly from the task checklist.
