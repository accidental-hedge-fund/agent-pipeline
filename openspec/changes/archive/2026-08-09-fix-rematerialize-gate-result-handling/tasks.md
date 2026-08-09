## 1. Verify current consumer branches

- [ ] 1.1 Confirm `EnsureManagedWorktreeResult` producer contract remains `pass` | `skipped` | `fail` in `core/scripts/worktree.ts`.
- [ ] 1.2 Inspect design-gate, visual-gate, and eval-gate rematerialize branches for any remaining `"ok"` success check or other false-fail path that parks successful rematerialize.
- [ ] 1.3 Compare against correct consumers (`fix.ts`, pre-merge archive/routing, loop repair) that branch only on `result === "fail"`.

## 2. Align gate consumer handling

- [ ] 2.1 In design-gate, accept `pass` and `skipped` with a non-null worktree; park only on `fail` (retain defensive park when non-fail lacks a worktree path); reason text must never format success as `failed (undefined)`.
- [ ] 2.2 Apply the same consumer contract in visual-gate.
- [ ] 2.3 Apply the same consumer contract in eval-gate.
- [ ] 2.4 Preserve existing typed `blockerKind` handling for true `fail` (`worktree-missing` | `worktree-creation-failed` | `worktree-capacity`).

## 3. Regression tests

- [ ] 3.1 `core/test/design-gate-stage.test.ts`: missing worktree + production-shaped `pass` advances without `setBlocked`; production-shaped `skipped` with path continues; keep existing fail and null-worktree cases.
- [ ] 3.2 `core/test/visual-gate.test.ts`: missing worktree + `pass` / `skipped` with path supply the returned path to the visual runner and do not false-park; keep existing fail case.
- [ ] 3.3 `core/test/eval.test.ts`: missing worktree + `pass` / `skipped` with path supply the returned path to the eval runner and do not false-park; keep existing fail case.
- [ ] 3.4 Prove success-path tests would fail if the `"ok"` (or equivalent false-fail) check were reintroduced.

## 4. Mirror and CI

- [ ] 4.1 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change.
- [ ] 4.2 Run targeted unit tests for the three stages, then `npm run ci` from the repo root until green.
- [ ] 4.3 `openspec validate fix-rematerialize-gate-result-handling` remains green.
