## 1. Empty-name refuse at validateItem

- [ ] 1.1 Add a `core/test/openspec.test.ts` case that calls `validateItem` with `""` and with whitespace, and verify it fails on current code because the wrapper still forwards the empty name (or would surface `Nothing to validate`)
- [ ] 1.2 Return an invalid `ValidateResult` from `validateItem` when the name is empty or whitespace-only, without calling `runOpenspec`, and verify the new test passes and the result text does not include `Nothing to validate`

## 2. Restore via existing singularity

- [ ] 2.1 Add an optional inject bag on `makeOpenspecPlanningHooks` for `listChangeDirs` and `validateItem`, and verify production still defaults to `openspec.listChangeDirs` / `openspec.validateItem` while a unit test can replace both
- [ ] 2.2 Add a hook-level regression that constructs OpenSpec hooks, skips `authorArtifact`, injects one fresh change dir, and calls `revalidateArtifact`, and verify it fails today because `validateItem` is invoked with `""`
- [ ] 2.3 When the closed-over change id is empty, restore with `validateOpenspecChangeSingular` on `{ fresh, all }` from injected `listChangeDirs(worktree)` versus `beforeList` before any `validateItem` call in `validateArtifact` and `revalidateArtifact`, and verify the 2.2 test now passes with the restored id
- [ ] 2.4 Add hook-level cases for exactly-one active-change fallback, zero active changes, and multiple fresh changes, and verify restore uses the single active id, blocks with a named change-id restore reason (not `Nothing to validate`), and never invokes `validateItem` with `""`

## 3. Plan-review resume regression

- [ ] 3.1 Drive `runPlanningPhases` with `resumePlanReview: true`, OpenSpec hooks, one restorable change, a `NEEDS_REVISION` plan-review, and a successful revision, injecting `listChangeDirs` / `validateItem`, and verify the test fails if restore is skipped or `validateItem` receives `""` and passes when the restored id is validated
- [ ] 3.2 Confirm plan-review resume still skips `authorArtifact` in that same test, and verify the authoring harness invoke count stays zero

## 4. Scope freeze and CI

- [ ] 4.1 Confirm the diff does not change train, merge-authority, review-policy, or park-release behavior, and verify `git diff` has no edits under those modules except incidental shared-type churn
- [ ] 4.2 After any `core/` edit run `node scripts/build.mjs`, and verify `node scripts/build.mjs --check` passes
- [ ] 4.3 Run `openspec validate restore-openspec-changeid-on-plan-review-resume` and `openspec validate --all`, and verify both exit 0
- [ ] 4.4 Run `npm run ci` from the repo root, and verify the full gate passes
