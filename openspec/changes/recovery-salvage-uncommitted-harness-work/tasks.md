## 1. New `salvageUncommittedWork` module

- [ ] 1.1 Create `core/scripts/salvage-harness-work.ts` with a `SalvageDeps` interface (`gitStatus`, `gitAddAll`, `gitCommit` seams) and a `salvageUncommittedWork(wtPath, issueNumber, pipelineRunId, stageLabel, deps?)` function that: checks porcelain status, returns `{salvaged: false}` when clean, or stages + commits with the `salvage:` message + trailers and returns `{salvaged: true}` when dirty.
- [ ] 1.2 Write `core/test/salvage-harness-work.test.ts` with three cases: (a) dirty → salvaged commit + returns `{salvaged: true}`, (b) clean → no git calls + returns `{salvaged: false}`, (c) `gitCommit` throws → propagates the error. Prove each bites (fails without the implementation).

## 2. Wire salvage into `planning.ts` (implement stage)

- [ ] 2.1 After the implement harness exits, before the existing `verifyHarnessCommits` call that can return "No commits found in the range", add a dirty-check: if `headBefore === headAfter`, call `salvageUncommittedWork`; if it returns `{salvaged: true}`, re-read `headAfter` and continue; if it returns `{salvaged: false}`, fall through to the existing block path unchanged.
- [ ] 2.2 Wire the same salvage pre-pass into the OpenSpec authoring harness commit-check site (`planning.ts` around line 457 where `verifyHarnessCommits` is called for the `osAuthorHeadBefore` range).

## 3. Wire salvage into `fix.ts` (fix rounds and test-fix)

- [ ] 3.1 At the `headBefore === headAfter` guard in `advanceFixRound` (`fix.ts:126`), add the same salvage pre-pass before calling `setBlocked("no new commits")`. On salvage success, re-read `headAfter` and continue.
- [ ] 3.2 Confirm the test-fix loop inside the test gate (`eval.ts` or wherever test-fix harness runs) also has a `headBefore`/`headAfter` commit check; add the salvage pre-pass there if present.

## 4. Tests for the wired-in salvage paths

- [ ] 4.1 `planning.test.ts` (or new fixture): dirty-worktree-no-commit → salvage called, `verifyHarnessCommits` sees the new commit, pipeline advances. Prove it bites (fails when `salvageUncommittedWork` is a no-op).
- [ ] 4.2 `fix.test.ts` (or new fixture): dirty-worktree-no-commit in a fix round → salvage called + pipeline continues to test gate. Prove it bites.
- [ ] 4.3 Clean-no-commit case (in each stage): `salvageUncommittedWork` not called, `setBlocked` fires as before. Prove it bites.
- [ ] 4.4 Salvaged commit fails test gate → `setBlocked` fires with test-gate reason (not "no new commits"). Prove it bites.

## 5. Mirror + CI

- [ ] 5.1 `node scripts/build.mjs` — regenerate `plugin/` mirror.
- [ ] 5.2 `npm run ci` passes green from repo root.
