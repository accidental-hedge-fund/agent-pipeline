## 1. Context and types

- [ ] 1.1 Add `entryGatesPassedForSha?: string` to `PreMergePollingContext` in `pre-merge-routing.ts` with a short comment that it records a clean entry-gate proceed for that head only
- [ ] 1.2 Add session-scoped cached PR number field on `PreMergePollingContext` (e.g. `prNumber?: number`) and document reuse within `advancePolling` only
- [ ] 1.3 Confirm facade re-exports still surface `PreMergePollingContext` / related types via `pre_merge.ts` without import-path churn

## 2. Advance control flow

- [ ] 2.1 After PR existence is known (and not dry-run), resolve `getPrDetail` early enough to read `head_sha` for the memo check; reuse or re-fetch as needed so early-conflict still sees current detail
- [ ] 2.2 When `pollingCtx` is present and `entryGatesPassedForSha === prDetail.head_sha`, skip review-SHA gate, OpenSpec archive, active-change guard, and entry-stack early-conflict bodies; jump to Step 1 CI with resolved `prNumber` / `prDetail`
- [ ] 2.3 When memo misses, run the full entry stack in existing order; set `entryGatesPassedForSha` only on clean proceed into Step 1 using the head SHA that actually enters CI (re-fetch after archive if HEAD may have moved)
- [ ] 2.4 Ensure every non-null entry-gate return path leaves the memo unset for that proceed (do not set on block / re-route / archive failure / guard failure / early-conflict recovery return)
- [ ] 2.5 Cache resolved `prNumber` on `pollingCtx` when present; reuse on later ticks in the same session
- [ ] 2.6 Keep the early-conflict predicate byte-identical: `mergeable === false || (mergeable_state ?? "").toUpperCase() === "DIRTY"`
- [ ] 2.7 Leave one-shot `advance` without `pollingCtx` on the full-stack path every call

## 3. Tests

- [ ] 3.1 Add multi-tick pending-CI test (shared `pollingCtx`, stub `getPrChecks` pending for ≥10 ticks, unchanged head) asserting entry-gate deps run on the first proceed only and later ticks stay at ~1–2 load-bearing gh/detail/check calls
- [ ] 3.2 Add head-invalidation regression: memo for H1, then head H2 → full entry stack re-runs; structure the assertion so removing the SHA equality check fails the test
- [ ] 3.3 Add non-proceed test: forced non-null SHA-gate / archive / guard outcome does not set `entryGatesPassedForSha`; next same-head tick still runs the stack
- [ ] 3.4 Assert early-conflict predicate stability (shared constant/helper or equivalent) and UNKNOWN/BEHIND fall-through unchanged
- [ ] 3.5 Keep all new tests on injectable deps only (no real network, git, or subprocess)

## 4. Verify and land

- [ ] 4.1 Run focused pre-merge tests for the new cases, then broader pre-merge suite as needed
- [ ] 4.2 If any `core/` sources that participate in the plugin mirror changed, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit
- [ ] 4.3 Run `openspec validate pre-merge-entry-gate-head-anchor` and `npm run ci` until green
- [ ] 4.4 Confirm no gate policy removals/demotions and no auto-merge path in the diff
