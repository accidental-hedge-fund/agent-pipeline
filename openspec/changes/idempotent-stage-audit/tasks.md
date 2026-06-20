## 1. Add idempotency key to transition and blocker comments

- [x] 1.1 Define a `buildAuditSentinel(runId: string, state: string): string` pure helper in `core/scripts/gh.ts` that returns `<!-- pipeline-audit: run=<runId> state=<state> -->`.
- [x] 1.2 Update `transition()` to append `buildAuditSentinel(runId, toStage)` to the comment body before calling `postComment`. The `runId` parameter SHALL be added to `transition()`'s signature with a sensible default (the active run-directory slug or a module-level constant set at startup).
- [x] 1.3 Update `setBlocked()` to append `buildAuditSentinel(runId, "blocked")` to the comment body. Same `runId` sourcing as above.

## 2. Add in-process retry wrapper for comment posts

- [x] 2.1 Add a `retryComment(thunk: () => Promise<void>, attempts?: number): Promise<void>` helper in `core/scripts/gh.ts` that retries up to 3 times on any thrown error, with exponential backoff (1 s, 2 s).
- [x] 2.2 Wrap the `postComment` call in `transition()` with `retryComment`.
- [x] 2.3 Wrap the `postComment` call in `setBlocked()` with `retryComment`.
- [x] 2.4 Write unit tests for `retryComment`: succeeds on first attempt (no retries), succeeds on second attempt (one retry), exhausts all attempts and re-throws the last error.

## 3. Add reconciliation logic

- [x] 3.1 Add `reconcileAuditComment(cfg, issueNumber, currentState, runId, commentBody, deps)` to `core/scripts/gh.ts` (or a thin new `reconcile.ts`). It SHALL: (a) scan the issue's recent comments (cap at 20) for `<!-- pipeline-audit: ... state=<currentState> -->`; (b) if found, return without action; (c) if not found, post `commentBody` via `postComment` and log a warning.
- [x] 3.2 Call `reconcileAuditComment` at the start of each dispatch cycle (after the current stage is resolved) from `pipeline.ts` or the advance dispatcher, passing the resolved current stage as `currentState` and the pre-fetched `getIssueDetail` comments to avoid an extra network call.
- [x] 3.3 Write unit tests for the reconciler:
  - Marker present → no comment posted (verified via fake `postComment` not called).
  - Marker absent, current state matches label → repair comment posted exactly once.
  - Marker absent but for a different state → reconciler posts (fix-1 sentinel absent even when review-1 sentinel exists).

## 4. Write regression tests for the partial-write scenario

- [x] 4.1 Write a unit test for `transition()` where the first `postComment` call throws and the retry (via `retryComment`) succeeds — confirm exactly one comment is posted and the sentinel is present.
- [x] 4.2 Write a unit test where all `postComment` retries fail — confirm the error is propagated and no partial comment is left (the sentinel is not present in a half-written body).
- [x] 4.3 Write a unit test simulating a cross-run repair: label is in state X, but no matching sentinel comment exists → reconciler posts the repair comment exactly once; a second reconciler call finds the sentinel and skips.

## 5. Verify and finalize

- [x] 5.1 Run `npm run ci` from the repo root and confirm all tests pass.
- [x] 5.2 Regenerate the plugin mirror: `node scripts/build.mjs` and verify `--check` passes.
- [x] 5.3 Commit `core/` changes and regenerated `plugin/` together in one commit.
