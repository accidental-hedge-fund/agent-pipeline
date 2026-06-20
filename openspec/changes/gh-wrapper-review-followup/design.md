## Context

`core/scripts/gh.ts` owns all GitHub I/O and exposes `ghRun` — an async `execFileAsync` wrapper with a configurable timeout (default 30 s) and exponential-backoff retry on rate-limit errors. Every `gh` invocation in the codebase uses it, except for two closures in `review.ts`:

- `defaultCreateIssue` — `gh issue create`, used when filing a ceiling follow-up issue.
- `defaultAddIssueComment` — `gh issue comment`, used when appending findings to an existing follow-up.

Both currently call `spawnSync`, which blocks the event loop, ignores the timeout, and doesn't retry rate limits.

## Goals / Non-Goals

**Goals:**
- Move `createIssue` and `addIssueComment` into `gh.ts` as exported async helpers on top of `ghRun`.
- Remove all `spawnSync` usage from `review.ts`.
- Keep the `deps` seam interface (`createIssue`/`addIssueComment`) unchanged so tests require no updates.

**Non-Goals:**
- Changing follow-up issue or comment content.
- Changing state-machine edges or ceiling behavior.
- Adding new retry policies beyond what `ghRun` already provides.

## Decisions

### D1 — New helpers in `gh.ts`, not inline in `review.ts`

**Decision:** Add `createIssue` and `addIssueComment` to `gh.ts` as first-class exports.

**Rationale:** All other GitHub operations (label writes, PR creation, comment posts, etc.) live in `gh.ts`. Keeping the pattern consistent means future callers get the right transport without copy-pasting, and unit tests for the helper logic can live next to the other `gh.ts` tests.

**Alternative considered:** Rewrite the closures in `review.ts` in place without touching `gh.ts`. Rejected: duplicates the `ghRun` call pattern and leaves the helpers inaccessible to future stages.

### D2 — Signature mirrors the `deps` interface

**Decision:** `createIssue(cfg, title, body, labels)` returns `Promise<number>` (the issue number); `addIssueComment(cfg, issueNumber, body)` returns `Promise<void>`.

**Rationale:** The existing `AdvanceReviewDeps.createIssue` and `AdvanceReviewDeps.addIssueComment` seam types already define these signatures. Matching them means `defaultCreateIssue` and `defaultAddIssueComment` become one-line delegates with zero interface change.

### D3 — `defaultCreateIssue`/`defaultAddIssueComment` become thin delegates

**Decision:** The closure factories remain in `review.ts` (they're package-private and called from two call sites), but each immediately delegates to the new `gh.ts` helper. The closures lose all `spawnSync` logic.

**Rationale:** Minimal diff. Retaining the factory structure preserves the `deps`-injection API and avoids a wider refactor across call sites.

## Risks / Trade-offs

- **Async vs. sync event-loop behavior** → `spawnSync` blocked the event loop; replacing it with `async` + `await` is strictly better for pipeline responsiveness. No regression risk.
- **Timeout now enforced** → Previously a wedged `gh issue create` would block forever; now it times out at 30 s (default) and throws. This is the desired outcome but may surface previously hidden `gh` hangs in CI — treat those as newly visible bugs, not regressions.
- **Rate-limit retry added** → The new path retries on rate-limit errors (up to 3 attempts). Side effect: what was an immediate failure may now take a few seconds on a rate-limited `gh` instance. Acceptable because this path is already in a slow follow-up-filing code path.

## Migration Plan

1. Add `createIssue` and `addIssueComment` to `gh.ts`.
2. Rewrite `defaultCreateIssue` and `defaultAddIssueComment` in `review.ts` to call the new helpers.
3. Remove `spawnSync` import from `review.ts`.
4. Add unit tests for the new helpers in `gh.test.ts` (or the nearest co-located test file).
5. Run `npm run ci`; confirm all existing review-ceiling tests still pass.

No migration of stored data or external state is needed — this is a pure transport change.

## Open Questions

- None. The `ghRun` contract is well-established; the `deps` seam already exists; the argument shapes are confirmed by reading the `spawnSync` calls.
