## 1. New `salvageUncommittedWork` module

- [x] 1.1 Create `core/scripts/salvage-harness-work.ts` with a `SalvageDeps` interface (`gitStatus`, `gitAddAll`, `gitCommit` seams) and a `salvageUncommittedWork(wtPath, issueNumber, pipelineRunId, stageLabel, deps?)` function that: checks porcelain status, returns `{salvaged: false}` when clean, or stages + commits with the `salvage:` message + trailers and returns `{salvaged: true}` when dirty.
- [x] 1.2 Write `core/test/salvage-harness-work.test.ts` with three cases: (a) dirty → salvaged commit + returns `{salvaged: true}`, (b) clean → no git calls + returns `{salvaged: false}`, (c) `gitCommit` throws → propagates the error. Prove each bites (fails without the implementation).

## 2. Wire salvage into `planning.ts` (implement stage)

- [x] 2.1 After the implement harness exits, before the existing `verifyHarnessCommits` call that can return "No commits found in the range", add a dirty-check: if `headBefore === headAfter`, call `salvageUncommittedWork`; if it returns `{salvaged: true}`, re-read `headAfter` and continue; if it returns `{salvaged: false}`, fall through to the existing block path unchanged. (Wired at both implement sites — freeform and OpenSpec — via the shared `salvageIfNoNewCommit` pre-pass.)
- [x] 2.2 Wire the same salvage pre-pass into the OpenSpec authoring harness commit-check site (`planning.ts` around line 457 where `verifyHarnessCommits` is called for the `osAuthorHeadBefore` range).

## 3. Wire salvage into `fix.ts` (fix rounds and test-fix)

- [x] 3.1 At the `headBefore === headAfter` guard in `advanceFixRound` (`fix.ts:126`), add the same salvage pre-pass before calling `setBlocked("no new commits")`. On salvage success, re-read `headAfter` and continue.
- [x] 3.2 Confirm the test-fix loop inside the test gate (`eval.ts` or wherever test-fix harness runs) also has a `headBefore`/`headAfter` commit check; add the salvage pre-pass there if present. (The loop lives in `core/scripts/testgate.ts`; salvage is wired before the post-fix clean-tree check, gated on `headBefore === headAfter` AND a dirty tree, with a `salvage` seam on `TestGateDeps`.)

## 4. Tests for the wired-in salvage paths

- [x] 4.1 `planning.test.ts` (or new fixture): dirty-worktree-no-commit → salvage called, `verifyHarnessCommits` sees the new commit, pipeline advances. Prove it bites (fails when `salvageUncommittedWork` is a no-op). (Covered as contract tests in `salvage-harness-work.test.ts`: the salvage message passes `enforceImplCommitRef`, and the no-salvage empty range reproduces the "No commits found in the range" block — `advance()` has no injectable seam, matching the repo's exported-gate test pattern.)
- [x] 4.2 `fix.test.ts` (or new fixture): dirty-worktree-no-commit in a fix round → salvage called + pipeline continues to test gate. Prove it bites. (Contract tests in `salvage-harness-work.test.ts` pin `fixSalvageStageLabel` against `enforceFixCommitGate` for both rounds; wired-loop coverage in `testgate.test.ts` proves the end-to-end salvage path through `runTestGate`.)
- [x] 4.3 Clean-no-commit case (in each stage): `salvageUncommittedWork` not called, `setBlocked` fires as before. Prove it bites. (Unit: clean status → no git mutations; loop: `testgate.test.ts` "clean worktree with no commit → salvage not attempted, no-commit block unchanged".)
- [x] 4.4 Salvaged commit fails test gate → `setBlocked` fires with test-gate reason (not "no new commits"). Prove it bites. (`testgate.test.ts` "salvaged but tests still fail → blocked with the test-gate reason".)

## 5. Mirror + CI

- [x] 5.1 `node scripts/build.mjs` — regenerate `plugin/` mirror.
- [x] 5.2 `npm run ci` passes green from repo root.
