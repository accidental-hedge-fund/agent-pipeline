## 1. Context and types

- [x] 1.1 Add `entryGatesPassedForSha?: string` to `PreMergePollingContext` in `pre-merge-routing.ts` with a short comment that it records a clean **head-bound** entry-gate proceed for that head only
- [x] 1.2 Add session-scoped `prNumber?: number` on `PreMergePollingContext` and document reuse only while the PR remains open (validated via per-tick `getPrDetail`)
- [x] 1.3 Confirm facade re-exports still surface `PreMergePollingContext` / related types via `pre_merge.ts` without import-path churn

## 2. Advance control flow

- [x] 2.1 Resolve PR identity: use `pollingCtx.prNumber` when set, else `getPrForIssue`; store open PR number on context when present
- [x] 2.2 Hoist `getPrDetail` early (after dry-run skip). If detail missing/throws or `state !== "open"`, clear `prNumber` + `entryGatesPassedForSha`, re-resolve via `getPrForIssue`, and re-fetch detail (or block with existing no-PR path)
- [x] 2.3 When `pollingCtx` is present and `entryGatesPassedForSha === prDetail.head_sha`, skip only review-SHA gate, OpenSpec archive, and active-change guard; **do not** skip early-conflict or Step 1 CI
- [x] 2.4 When memo misses, run full entry stack in existing order (SHA gate → preArchive capture → archive → active-change guard)
- [x] 2.5 After a full stack that may move HEAD (archive), re-fetch `getPrDetail` before early-conflict and before setting the memo so the memo SHA is the post-stack head that enters CI
- [x] 2.6 Always evaluate early-conflict with the byte-identical predicate on the current open `prDetail`; conflict recovery return must not set the proceed memo
- [x] 2.7 Set `entryGatesPassedForSha` only on clean proceed into Step 1 (full-stack path completed, not early conflict)
- [x] 2.8 Leave one-shot `advance` without `pollingCtx` on the full-stack path every call

## 3. Tests

- [x] 3.1 Multi-tick pending-CI test (shared `pollingCtx`, stub `getPrChecks` pending ≥10 ticks, unchanged open head): head-bound entry-gate deps run on first proceed only; later ticks stay at CI-path reads (PR detail + checks)
- [x] 3.2 Head-invalidation regression: memo for H1, then head H2 → full head-bound stack re-runs; structure so removing the SHA equality check fails the test
- [x] 3.3 Non-proceed test: forced non-null SHA-gate / archive / guard / early-conflict recovery does not set `entryGatesPassedForSha`; next same-head tick still runs the stack
- [x] 3.4 Unchanged head + base-driven DIRTY / `mergeable === false` still takes conflict recovery (memo hit does not skip early-conflict)
- [x] 3.5 Archive-induced head movement in one pass records post-archive SHA on `entryGatesPassedForSha`
- [x] 3.6 Cached `prNumber` for a closed/missing PR is cleared; identity re-resolved; entry memo cleared; closed PR is not kept as the poll target
- [x] 3.7 Early-conflict predicate stability (shared helper or equivalent) and UNKNOWN/BEHIND fall-through unchanged
- [x] 3.8 All new tests use injectable deps only (no real network, git, or subprocess)

## 4. Verify and land

- [x] 4.1 Run focused pre-merge tests for the new cases, then broader pre-merge suite as needed
- [x] 4.2 If any `core/` sources that participate in the plugin mirror changed, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit
- [x] 4.3 Run `openspec validate pre-merge-entry-gate-head-anchor` and `npm run ci` until green
- [x] 4.4 Confirm no gate policy removals/demotions and no auto-merge path in the diff
