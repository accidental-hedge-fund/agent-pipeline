## 1. Introduce `PlanningRecoveryDeps` interface

- [ ] 1.1 Define `PlanningRecoveryDeps` in `pipeline.ts` (or a small helper module imported
  by it): `{ transition: typeof transition; planningAdvance: typeof planningStage.advance }`.
- [ ] 1.2 Wire `realPlanningRecoveryDeps()` using the live imports (default for production).

## 2. Update the dispatch switch

- [ ] 2.1 Replace the `planning` / `plan-review` `waiting` return in `dispatchStage()` with
  recovery logic:
  - Log `[pipeline] #${issueNumber}: recovered stranded planning attempt — restarting from
    ready`.
  - Call `deps.transition(cfg, issueNumber, stage as Stage, "ready", "recovered crashed
    planning attempt — restarting")`.
  - Return `await deps.planningAdvance(cfg, issueNumber, { dryRun, model, pipelineRunId,
    stateDir, runDir, runStoreDeps })`.
- [ ] 2.2 Ensure the `plan-review` case falls through to the same handler as `planning`
  (single `case "planning": case "plan-review":` block).

## 3. Unit tests

- [ ] 3.1 Stranded `planning` → restart: fake `transition` records its args; fake
  `planningAdvance` returns `{ advanced: true, from: "ready", to: "review-1", summary: "..." }`;
  assert the outcome is advancing and `transition` was called with `(cfg, N, "planning",
  "ready", <any string>)`.
- [ ] 3.2 Stranded `plan-review` → restart: same shape as 3.1 with `"plan-review"` as the
  starting stage; assert `transition` was called with `(cfg, N, "plan-review", "ready", ...)`.
- [ ] 3.3 Regression — `planning` no longer returns `waiting`: assert the outcome status is
  NOT `"waiting"` when stage is `"planning"`.
- [ ] 3.4 Regression — `plan-review` no longer returns `waiting`: same assertion for
  `"plan-review"`.
- [ ] 3.5 Prove tests bite: temporarily revert 2.1 (or comment out the new logic), run the
  suite, confirm 3.1–3.4 fail, then restore.

## 4. Mirror + CI

- [ ] 4.1 `node scripts/build.mjs` — regenerate `plugin/` mirror.
- [ ] 4.2 `npm run ci` green end-to-end.
