## 1. Wire scoped salvage on the plan-revision path

- [x] 1.1 In `core/scripts/stages/planning.ts` `runPlanningPhases`, capture HEAD with the injected `gitInWorktree` seam immediately before the first plan-revision invoke, and verify a unit test can supply that HEAD through the existing deps seam (no real git).
- [x] 1.2 After that successful initial invoke, call `salvageIfNoNewCommit` immediately (before ack validation) with stage label for plan revision, that invoke’s HEAD, scope `openspec/`, and the injected `gitInWorktree` / `trySalvageUncommittedWork` seams. Verify the call uses scope `openspec/` and does not use `runHarnessRound`.
- [x] 1.3 Inside the format-repair `repairInvoke`, capture HEAD again immediately before the retry invoke. After a successful retry process exit, call `salvageIfNoNewCommit` with that retry HEAD and scope `openspec/` before returning stdout to the contract helper. Verify retry salvage is not skipped merely because the initial salvage advanced HEAD.
- [x] 1.4 Run those salvages before `revalidateArtifact` and before any plan-review `setBlocked` that can follow a successful invoke (ack exhausted, facts claims, revalidate, human-feedback ack, standalone salvage-failure block). Verify a blocked outcome after a successful dirty-`openspec/` revision cannot occur without a salvage attempt.
- [x] 1.5 Leave implement, fix-round, and test-fix salvage call sites unscoped. Verify existing unscoped salvage tests still pass.

## 2. Disclose salvage failure on every plan-review blocker

- [x] 2.1 Persist the salvage `failureReason` from `salvageIfNoNewCommit`. When a salvage attempt fails, append the existing authoring/implement phrasing (`Salvage of uncommitted work also failed: …`) to every subsequent plan-review blocker reason (ack invoke-failed, contract-exhausted, claims, revalidate, human-feedback ack). Do not overwrite an earlier failure with a later generic reason. Do not infer success from a later clean worktree status. Verify unit tests assert that string on a fake salvage `failureReason` for revalidate-fail and contract-exhausted paths.
- [x] 2.2 When salvage fails and revalidate plus human-feedback ack otherwise succeed, block at plan-review with existing kind `harness-failure`, disclose the salvage failure, and do not advance to implementing. Verify a unit test for this terminal path.
- [x] 2.3 When salvage is not attempted (in-scope clean) or a later salvage on this step succeeds, leave the existing revalidate/ack/claims blocker wording unchanged. Verify a clean-`openspec/` revalidate-failure test does not include a salvage-failure section.

## 3. Biting regression tests with an event log

- [x] 3.1 Add a `core/test/planning.test.ts` unit test: successful plan-revision, `headAfter === headBefore`, dirty `openspec/`, then revalidate block. Record an event log of HEAD/salvage/revalidate/`setBlocked`. Assert salvage is called with scope `openspec/` at an earlier index than revalidate, and revalidate earlier than `setBlocked`. Inject git/salvage seams. No real git, network, or harness subprocess. Supply a non-empty HEAD (the default planning fake returns empty stdout and would skip salvage).
- [x] 3.2 Prove the 3.1 test bites: the same inputs without the salvage call return blocked without attempting salvage.
- [x] 3.3 Add a unit test that a successful format-repair retry also attempts `openspec/`-scoped salvage before revalidate or the contract-exhausted block. Event log must show salvage after the retry invoke and before the later block.
- [x] 3.4 Add a unit test that initial salvage `salvaged: true` advances the fake HEAD, the retry then leaves new dirty `openspec/` work, and retry salvage is still attempted because comparison HEAD was recaptured. This test SHALL fail if retry salvage reuses the pre-initial HEAD.
- [x] 3.5 Add a unit test that plan-revision salvage is invoked with scope `openspec/` (out-of-scope dirt such as `tasks/todo.md` is not passed as the staged scope). Reuse the existing helper assertion in `core/test/salvage-harness-work.test.ts` for add-args; the planning test asserts the call-site scope.
- [x] 3.6 Add a unit test that clean `openspec/` (salvage returns `{ salvaged: false }` with no `failureReason`) creates no salvage commit and leaves existing revalidate/block wording unchanged.
- [x] 3.7 Add a unit test that failed salvage plus successful revalidate still blocks at plan-review and names the salvage failure.

## 4. Build and CI

- [x] 4.1 After any `core/` edit, run `node scripts/build.mjs` from the repo root and verify `--check` is clean.
- [x] 4.2 Run `npm run ci` from the repo root and treat red as not-done. Make no test-pass claim until that gate is green.
