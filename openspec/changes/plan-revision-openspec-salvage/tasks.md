## 1. Wire scoped salvage on the plan-revision path

- [ ] 1.1 In `core/scripts/stages/planning.ts` `runPlanningPhases`, capture HEAD with the injected `gitInWorktree` seam immediately before the first plan-revision invoke, and verify a unit test can supply that HEAD through the existing deps seam (no real git).
- [ ] 1.2 After each successful plan-revision harness invoke (initial and format-repair retry), call `salvageIfNoNewCommit` with stage label for plan revision, that captured HEAD, scope `openspec/`, and the injected `gitInWorktree` / `trySalvageUncommittedWork` seams. Verify the call uses scope `openspec/` and does not use `runHarnessRound`.
- [ ] 1.3 Run that salvage before `revalidateArtifact` and before any plan-review `setBlocked` that can follow a successful invoke (ack exhausted, facts claims, revalidate, human-feedback ack). Verify a blocked outcome after a successful dirty-`openspec/` revision cannot occur without a salvage attempt.
- [ ] 1.4 Leave implement, fix-round, and test-fix salvage call sites unscoped. Verify existing unscoped salvage tests still pass.

## 2. Disclose salvage failure on the plan-review blocker

- [ ] 2.1 Keep the salvage result from the plan-revision path and, when a salvage attempt fails, append the existing authoring/implement phrasing (`Salvage of uncommitted work also failed: …`) to the subsequent plan-review blocker reason. Verify a unit test asserts that string on a fake salvage `failureReason`.
- [ ] 2.2 When salvage is not attempted (in-scope clean) or salvage succeeds, leave the existing revalidate/ack/claims blocker wording unchanged. Verify a clean-`openspec/` revalidate-failure test does not include a salvage-failure section.

## 3. Biting regression tests

- [ ] 3.1 Add a `core/test/planning.test.ts` unit test: successful plan-revision, `headAfter === headBefore`, dirty `openspec/`, then revalidate block. Assert salvage is called with scope `openspec/` before the blocked return. Inject git/salvage seams. No real git, network, or harness subprocess.
- [ ] 3.2 Prove the 3.1 test bites: the same inputs without the salvage call return blocked without attempting salvage.
- [ ] 3.3 Add a unit test that a successful format-repair retry also attempts `openspec/`-scoped salvage before revalidate or the contract-exhausted block, using injected seams.
- [ ] 3.4 Add a unit test that plan-revision salvage does not stage an out-of-scope path (for example `tasks/todo.md`) when both that path and `openspec/` are dirty, or reuse an existing scoped-salvage assertion if it already covers the helper and the new call site passes `openspec/`.

## 4. Build and CI

- [ ] 4.1 After any `core/` edit, run `node scripts/build.mjs` from the repo root and verify `--check` is clean.
- [ ] 4.2 Run `npm run ci` from the repo root and treat red as not-done.
