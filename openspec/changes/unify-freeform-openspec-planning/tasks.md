## 1. Define the Hook Interface

- [x] 1.1 In `core/scripts/stages/planning.ts`, declare the `PlanningPhaseHooks` interface with fields: `authorArtifact`, `validateArtifact`, `revalidateArtifact`, `buildPrBody`, and `buildTransitionMessage`.
- [x] 1.2 Export `PlanningPhaseHooks` so unit tests can construct fake implementations directly.

## 2. Extract the Shared Phase Runner

- [x] 2.1 Extract the shared lifecycle from `advance` into a new internal `runPlanningPhases(cfg, issueNumber, opts, hooks, deps)` function. It shall implement: carry-forward → bootstrap → `hooks.authorArtifact` → transition `ready→planning` → plan comment → plan-review (if enabled) → human-feedback-ack check → plan-revision → `hooks.revalidateArtifact` → transition `plan-review→implementing` → `invokeImplementer` → salvage → commit checks → `resumeFromImplementing`.
- [x] 2.2 Thread the existing `deps` injection parameters (`BootstrapWorktreeDeps`, `PlanStepDeps`, `ImplementerInvokeDeps`, `ResumeFromImplementingDeps`) through `runPlanningPhases` via a combined deps parameter so all pre-existing unit-test seams remain valid.

## 3. Implement FreefformPlanningHooks

- [x] 3.1 Implement `FreefformPlanningHooks` as a concrete `PlanningPhaseHooks` value: `authorArtifact` calls `invokePlanStep`, `validateArtifact` / `revalidateArtifact` are no-ops returning `{ ok: true }`, `buildPrBody` and `buildTransitionMessage` produce the existing freeform strings.
- [x] 3.2 Rewrite `advance` to construct `FreefformPlanningHooks` and delegate to `runPlanningPhases`. Remove the now-duplicated lifecycle logic from `advance`.

## 4. Implement OpenspecPlanningHooks

- [x] 4.1 Implement `OpenspecPlanningHooks` as a concrete `PlanningPhaseHooks` value: `authorArtifact` calls the OpenSpec authoring harness + `enforceOpenspecChangeSingular` + salvage; `validateArtifact` runs `openspec.validateItem` and `openspec.readSpecDeltas`; `revalidateArtifact` re-runs `openspec.validateItem` and re-reads spec deltas; `buildPrBody` and `buildTransitionMessage` produce the existing OpenSpec strings (with change ID).
- [x] 4.2 Rewrite `advanceOpenspec` to construct `OpenspecPlanningHooks`, call the shared bootstrap + OpenSpec-init preamble, then delegate to `runPlanningPhases`. Remove the now-duplicated lifecycle logic from `advanceOpenspec`.

## 5. Paired Blocker-Equivalence Tests

- [x] 5.1 In `core/test/planning.test.ts`, add a test group `"runPlanningPhases — blocker equivalence"` with one test per failure mode: bootstrap failure (creation + setup), plan-generation failure, plan-review failure, plan-revision failure, human-feedback-ack failure, implementation harness failure, no-commits, and PR-creation failure.
- [x] 5.2 Each test runs `runPlanningPhases` twice — once with `FreefformPlanningHooks` fakes and once with `OpenspecPlanningHooks` fakes (both returning the failure under test) — and asserts that `setBlocked` is called with the same `tag` and the same reason prefix in both cases.
- [x] 5.3 Verify that each new test fails (red) without the implementation, then passes (green) with it.

## 6. Verify Pre-Existing Tests and CI

- [x] 6.1 Run `cd core && npm test` and confirm all pre-existing tests pass without any modification to existing test files.
- [x] 6.2 Run `node scripts/build.mjs` from the repo root to regenerate `plugin/` after all `core/` edits.
- [x] 6.3 Run `npm run ci` from the repo root and confirm the full gate (core tests + mirror sync + install smoke) passes green.
