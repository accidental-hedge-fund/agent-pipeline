## Why

`planning.ts` contains two nearly-identical top-level functions (`advance` and `advanceOpenspec`) that each independently implement the same sequence: carry-forward context gathering, worktree bootstrap, plan authoring, transition to `planning`, plan review, human feedback acknowledgement, plan revision, transition to `implementing`, implementation harness invocation, salvage, commit verification, and post-implementation steps. This duplication means bug fixes and policy changes must be applied in two places — the historical record shows this has already caused drift (e.g. carry-forward sanitization, human-feedback ack, plan-revision acknowledgement checks were all harder to keep in sync). Unifying behind a shared phase runner eliminates the drift surface while keeping the per-path hooks (OpenSpec artifact authoring vs. freeform plan text) as thin, replaceable implementations.

## What Changes

- Extract a parameterized `runPlanningPhases` function (or equivalent) that owns the shared lifecycle: carry-forward → bootstrap → plan-author hook → validate hook → transition planning → review → human-feedback ack → revision → re-validate hook → transition implementing → implement → salvage → commit checks → post-implementation.
- Define a `PlanningPhaseHooks` interface with hooks for the two things that differ: producing the planning artifact (freeform text vs. OpenSpec change authoring), and validating/reading back that artifact (no-op vs. `openspec validate` + `readSpecDeltas`).
- Implement `FreefromPlanningHooks` and `OpenspecPlanningHooks` as concrete implementations of that interface.
- Keep `advance` and `advanceOpenspec` as thin public entry points that construct the appropriate hooks and delegate to `runPlanningPhases`.
- All existing tests continue to pass without modification; new tests exercise the shared phase runner directly.

## Capabilities

### New Capabilities
- `unified-planning-phase-runner`: A shared internal planning lifecycle runner that both freeform and OpenSpec paths route through, parameterized by hooks that produce and validate the planning artifact.

### Modified Capabilities
- `openspec-integration`: The OpenSpec planning path's stage-transition and blocker behavior is unchanged, but the code now shares the phase-runner with the freeform path. No requirement changes — this is an internal structural change.
- `planning-grounded-research`: The planning prompt injection, carry-forward, and human-feedback-ack behavior is unchanged. No requirement changes.

## Impact

- `core/scripts/stages/planning.ts` — primary change site; the two large functions are refactored into a shared runner + two hook implementations.
- `core/test/planning.test.ts` (and any co-located test files) — new tests for the shared runner; existing tests should pass without change.
- `plugin/` mirror — must be regenerated via `node scripts/build.mjs` after `core/` edits.
- No config schema changes, no prompt changes, no new CLI flags.

## Acceptance Criteria

- [ ] A `runPlanningPhases` function (or equivalent) exists in `planning.ts` that handles carry-forward, bootstrap, plan authoring, transitions, review, revision, implementation, salvage, commit verification, and PR creation for both paths.
- [ ] `advance` (freeform) and `advanceOpenspec` (OpenSpec) each delegate to the shared runner through a hook interface; neither duplicates lifecycle logic.
- [ ] Paired unit tests prove that for bootstrap failure, plan-generation failure, plan-review failure, plan-revision failure, human-feedback-ack failure, implementation failure, no-commits failure, and PR-creation failure, the freeform and OpenSpec hooks produce the same blocker tag and reason prefix.
- [ ] All pre-existing tests in `core/test/` pass without modification.
- [ ] `npm run ci` passes (core tests + mirror sync + install smoke).
- [ ] No observable change in plan-comment content, reviewer invocation order, human-feedback-ack behavior, or PR body format on either path.
