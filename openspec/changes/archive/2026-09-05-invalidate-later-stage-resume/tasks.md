## 1. Inventory later-stage dispatch vs existing SHA surfaces

- [x] 1.1 Confirm `runAdvance` dispatch sites for `visual-gate`, `eval-gate`, `shipcheck-gate`, and in-loop `ready-to-deploy` finalize, and record that none currently call `resolveReviewedShaCurrency` / `reconcileReviewCurrency` before the handler
- [x] 1.2 Confirm nested whole-item advance, `pipeline single`, and loop item dispatch all enter `runAdvance`, and list any parallel later-stage entry that bypasses it
- [x] 1.3 Confirm `tryResumeStaleBlocked` still requires `pipeline:blocked` and eligible stages, so unblocked visual-gate resume cannot use it as the only guard

## 2. Dispatch-time later-stage review-currency guard

- [x] 2.1 Add a `runAdvance` later-stage guard that reuses `resolveReviewedShaCurrency` (or `reconcileReviewShaGateState` / `reconcileReviewCurrency`) before dispatching visual-gate, eval-gate, shipcheck-gate, or ready-to-deploy finalize, and verify a unit test fails when that later handler runs without the reconcile
- [x] 2.2 On `superseded`, atomically `transition` to `review-1`, skip the later-stage handler, and `continue` the same advance so review-1 can run, and verify the visual-gate-to-ready fail-open fixture no longer reaches ready-to-deploy
- [x] 2.3 On pipeline-internal-only `current`, dispatch the later stage unchanged, and verify the internal-only fixture does not force re-review
- [x] 2.4 On unreadable PR/HEAD, fail closed without dispatching the later stage or reaching ready-to-deploy, and verify the observation-failure fixture holds
- [x] 2.5 On `unknown` with readable H ≠ S, treat as new epoch and return to `review-1` (same as superseded), and verify the rebase-absent-S fixture does not stay at visual-gate
- [x] 2.6 Select the first enabled exact-SHA review stage, fail closed when none is enabled, clear a leftover block, and record the candidate-epoch restart durably
- [x] 2.7 Re-run the guard inside both in-loop and deferred ready-to-deploy finalization so a late HEAD move cannot race an earlier observation

## 3. Exact-SHA review after epoch change

- [x] 3.1 After later-stage return to `review-1`, require the next review to evaluate HEAD H and record `reviewed-sha` H, and verify the test asserts the S verdict is not reused as approval for H
- [x] 3.2 Leave pre-merge `enforceReviewShaGate` delta-review / diff-hash behavior unchanged while the issue remains at `pre-merge`, and verify existing SHA-gate tests still pass

## 4. Recovery noop classification after epoch change

- [x] 4.1 After a new candidate epoch, keep `review-1` / `review-2` actionable even when checks on H are pending, and verify a recovery fixture does not classify that item as noop solely from pending checks
- [x] 4.2 After a new candidate epoch, persist or resume a Recovery Episode keyed to H and ignore S-episode cursor/exhaustion as authority to skip review, and verify a fixture with a failed S episode still treats review of H as actionable

## 5. Hermetic regressions

- [x] 5.1 Add a visual-gate unblocked resume fixture: review SHA S, developer HEAD H, label `pipeline:visual-gate` → no visual-gate handler, transition to `review-1`, no ready-to-deploy; prove the test fails without the guard
- [x] 5.2 Add sibling fixtures for `eval-gate`, `shipcheck-gate`, and `ready-to-deploy` that return to `review-1` before the later work runs
- [x] 5.3 Add pipeline-internal-only and unreadable-HEAD fixtures matching the spec scenarios
- [x] 5.4 Inject deps only (no real network, git, or subprocess) in all new tests
- [x] 5.5 Cover forged review comments, stale blocked state, disabled review-stage routing, durable epoch audit, and deferred-finalizer HEAD movement

## 6. Mirror, validate, CI

- [x] 6.1 After any `core/` edit, run `node scripts/build.mjs` and include refreshed host SKILLs in the same commit
- [x] 6.2 Run `openspec validate invalidate-later-stage-resume` (and `openspec validate --all` as needed) until clean
- [x] 6.3 Run `npm run ci` from the repo root and fix failures until green
