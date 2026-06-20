## Why

The review stage's follow-up issue and comment writes (`defaultCreateIssue`, `defaultAddIssueComment`) call `spawnSync("gh", ...)` directly, bypassing the shared `ghRun` async wrapper that supplies timeout enforcement, exponential-backoff rate-limit retry, and consistent error formatting used by every other GitHub call in the pipeline. A slow or rate-limited `gh` invocation in these paths can wedge the pipeline indefinitely and produces error messages that don't match the rest of the codebase, making incidents harder to diagnose.

## What Changes

- `core/scripts/gh.ts`: add two exported async helper functions — `createIssue` (wraps `gh issue create`, returns issue number) and `addIssueComment` (wraps `gh issue comment`) — built on the existing `ghRun` primitive so they inherit its timeout, retry, and error-formatting behavior.
- `core/scripts/stages/review.ts`: replace `defaultCreateIssue` and `defaultAddIssueComment` closures (which call `spawnSync`) with thin wrappers that delegate to the new `gh.ts` helpers. Remove the `spawnSync` import once it is no longer needed.
- Tests for `defaultCreateIssue` / `defaultAddIssueComment` paths in `review.test.ts` already inject `deps.createIssue` / `deps.addIssueComment` fakes — no test seam changes are needed; only the production default implementations change.

## Capabilities

### New Capabilities
- `gh-write-helpers`: The shared `gh.ts` module SHALL export `createIssue` and `addIssueComment` async helpers that delegate to `ghRun` and therefore inherit timeout enforcement, rate-limit retry, and consistent error messaging.

### Modified Capabilities
- `review-ceiling-demote-and-advance`: The default GitHub write implementations for follow-up issue creation and comment posting SHALL use the shared async `ghRun`-based helpers rather than synchronous `spawnSync` calls, so timeouts and retries apply uniformly.

## Impact

- `core/scripts/gh.ts` — two new exported async functions.
- `core/scripts/stages/review.ts` — `defaultCreateIssue` and `defaultAddIssueComment` rewritten; `spawnSync` import removed.
- No changes to state-machine edges, `deps` interfaces, or test seams.
- No behavioral change to follow-up issue / comment content; only the transport layer changes.

## Acceptance Criteria

- [ ] `gh.ts` exports `createIssue(cfg, title, body, labels): Promise<number>` and `addIssueComment(cfg, issueNumber, body): Promise<void>`.
- [ ] Both helpers are built on `ghRun`, so they enforce the 30 s default timeout and three-attempt rate-limit retry without any additional code.
- [ ] `defaultCreateIssue` and `defaultAddIssueComment` in `review.ts` delegate to the new helpers; all `spawnSync` references in `review.ts` are removed.
- [ ] Unit tests exercise `createIssue` and `addIssueComment` via fake `ghRun` deps, verifying correct `gh` argument construction and issue-number extraction.
- [ ] A simulated timeout (fake `ghRun` that never resolves / throws `ETIMEDOUT`) in a unit test confirms the path surfaces an error rather than hanging.
- [ ] All existing review-ceiling and follow-up behavior (idempotency marker, demotion comment, re-entry append) remains unchanged — existing tests still pass.
- [ ] `npm run ci` passes with no regressions.
