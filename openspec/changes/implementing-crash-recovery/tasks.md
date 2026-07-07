## 1. Thread the recovery deps into the implementing dispatch

- [x] 1.1 Extend `DispatchResumeDeps` in `core/scripts/stages/planning.ts` with the recovery
  seams: `isLivePlanningActive`, `transition`, `planningAdvance` (defaulting to the live
  imports), so the recovery branch is fakeable alongside the existing resume seams.
- [x] 1.2 In `core/scripts/pipeline-run.ts`, have the `implementing` case in `dispatch()` pass
  the existing `PlanningRecoveryDeps` (the same object the `planning` / `plan-review` cases
  use) through to `planningStage.dispatchResume()`.

## 2. Add the crash-stranded recovery branch to `dispatchResume`

- [x] 2.1 Add a liveness gate at the top of `dispatchResume` (after the dry-run short-circuit):
  if `isLivePlanningActive(cfg.repo, issueNumber)` is true, return
  `{ advanced: false, status: "waiting", reason: <names the live concurrent owner> }` without
  inspecting the worktree.
- [x] 2.2 Keep the existing resume path: no live owner AND worktree with commits ahead of
  `cfg.base_branch` → run gate → push → PR → `review-1` (unchanged).
- [x] 2.3 Replace the old no-commits `waiting` return with the recovery branch: no live owner
  AND no commits →
  - log `[pipeline] #${issueNumber}: recovered stranded implementing attempt — restarting from ready`;
  - call `transition(cfg, issueNumber, "implementing", "ready", "recovered crashed implementing attempt — restarting")` (guarded by `!opts.dryRun`, matching the planning recovery);
  - return `await planningAdvance(cfg, issueNumber, { dryRun, model, pipelineRunId, stateDir, runDir, runStoreDeps })`.
- [x] 2.4 Ensure the liveness check runs BEFORE the commits-ahead check (ordering matters for
  the resume-race guarantee).

## 3. Unit tests (`core/test/implementing-crash-recovery.test.ts` or extend planning tests)

- [x] 3.1 Crash-stranded (marker absent/dead, no worktree commits): fake `isLivePlanningActive`
  → false, fake `getForIssue` → null (or worktree with no commits); fake `transition` records
  its args; fake `planningAdvance` returns an advancing outcome. Assert the outcome is
  advancing, `transition` was called with `(cfg, N, "implementing", "ready", <string>)`, and
  the recovery log line was printed.
- [x] 3.2 Live owner (marker PID alive): fake `isLivePlanningActive` → true. Assert a
  `waiting` outcome whose reason names the live owner, and that `transition`,
  `planningAdvance`, and the resume path were NOT called (no worktree inspection).
- [x] 3.3 Resume preserved (no live owner, commits present): fake `isLivePlanningActive` →
  false, worktree with commits ahead. Assert the post-implementation resume runs and neither
  `transition` nor `planningAdvance` (restart) is called.
- [x] 3.4 Ordering: with a live marker AND a commit-bearing worktree, assert the outcome is
  `waiting` (liveness short-circuits before the commits check) — proves the gate ordering.
- [x] 3.5 Prove the tests bite: revert task 2.3 (restore the old no-commits `waiting` return),
  run the suite, confirm 3.1 (and 3.4 as applicable) fail, then restore.

## 4. Mirror + CI

- [x] 4.1 `node scripts/build.mjs` — regenerate the `plugin/` mirror.
- [x] 4.2 `npm run ci` green end-to-end (core tests + `build.mjs --check` + install smoke +
  `openspec validate --all`).
