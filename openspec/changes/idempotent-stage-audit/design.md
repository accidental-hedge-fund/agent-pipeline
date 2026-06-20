## Context

`gh.ts` provides two write operations that consist of two sequential GitHub calls:

- `transition(cfg, issueNumber, fromStage, toStage, summary)`: `gh issue edit` (label swap) → `postComment` (audit comment).
- `setBlocked(cfg, issueNumber, reason, stage, kind)`: `gh issue edit` (add `pipeline:blocked`) → `postComment` (blocker comment).

`ghRun` already retries rate-limit errors up to three times at the transport layer. However, a clean connection-level failure on the *comment* call (after the label write has committed) is not retried at the application layer — the caller sees an error and the issue is left with the new label but no comment.

The reconciliation gap is observable: on the next run, the pipeline sees the label and proceeds as if the transition was complete. The missing comment is never posted.

## Goals / Non-Goals

**Goals:**
- Embed an idempotency key in every transition and blocker comment so any run can check for its presence.
- Add a small in-process retry loop around the comment-post step in `transition()` and `setBlocked()`.
- Add a reconciler that runs at dispatch time and posts a repair comment when the expected key is missing.

**Non-Goals:**
- Changing the label schema, stage sequence, or any state-machine edges.
- Replacing `ghRun`'s existing transport-layer retry (this is an application-layer addition on top of it).
- Making the label write itself idempotent (GitHub's label API is already idempotent by nature — adding a label that is already present is a no-op).
- Retroactively repairing pre-existing missing comments on issues that were partially written before this change ships.

## Decisions

### D1 — Idempotency key format: sentinel in comment body

**Decision:** Append a sentinel HTML comment to every transition and blocker comment body:
```
<!-- pipeline-audit: run=<runId> state=<toStage|blocked> -->
```
Where `runId` is a short identifier available at dispatch time (e.g. the ISO timestamp slug already used in run directories, or a new uuid).

**Rationale:** Comment bodies are already searchable via `getIssueDetail`'s `comments` array. No new GitHub API call is needed. The marker is invisible to humans in rendered Markdown but trivially grep-able in the raw body.

**Alternative considered:** A separate GitHub label or a dedicated "audit" comment tag. Rejected: adds API surface and makes reconciliation more complex.

### D2 — Retry scope: application-layer wrapper, not ghRun change

**Decision:** Add a `retryComment` helper in `gh.ts` that wraps a `() => Promise<void>` comment-post thunk with up to 3 attempts and exponential backoff (1 s, 2 s), distinct from `ghRun`'s rate-limit retry.

**Rationale:** `ghRun`'s retry is already tuned to rate-limit errors specifically (keyed on `"rate limit"` in stderr). A broader connection-failure retry belongs at the call site, not in the transport. Keeping them separate avoids double-retry on rate limits.

### D3 — Reconciler placement: in the dispatch entry-point

**Decision:** The reconciler runs as the first step of `advance()` (in `pipeline.ts` or the stage dispatcher), after the current stage is resolved from labels but before any stage handler is invoked. It reads the last N comments (capped at 20), checks for the expected marker key for the current label state, and posts the repair comment if absent.

**Rationale:** This is the earliest safe point: the label is committed and readable; no stage handler has run yet. The cap (20 comments) prevents over-fetching on large issues — real-world partial writes are repaired within one run.

**Alternative considered:** Reconciling inside `transition()`/`setBlocked()` themselves on the retry-exhausted path. Rejected: the reconciler needs the comment history from `getIssueDetail`, which is already fetched at dispatch time and available without an extra call.

### D4 — Run ID source

**Decision:** Use the existing ISO-timestamp run-directory slug (the `runId` already threaded through the pipeline as the log/worktree path segment). If `runId` is unavailable at the reconciler call site, fall back to a per-process constant set at startup.

**Rationale:** Zero new state — the run slug already exists. The sentinel only needs to be unique enough to distinguish one partial write from the next; the timestamp slug is sufficient.

### D5 — Reconciler skips when marker present

**Decision:** Before posting a repair comment, the reconciler searches the issue's recent comments for `<!-- pipeline-audit: run=<anyRunId> state=<currentState> -->`. A partial regex match on `state=<currentState>` is sufficient — if *any* run posted the marker for the current state, the repair is not needed.

**Rationale:** The marker key needs to survive across run boundaries (the original run may have died before the next run was started). Matching on `state=` rather than `run=` avoids re-posting when a different run already repaired the gap.

## Risks / Trade-offs

- **Extra comment read at dispatch time** → The reconciler checks recent comments, which requires `getIssueDetail`. This call is already made in most stage handlers; the reconciler can reuse the result if the call is hoisted to dispatch time. Net impact: zero extra GitHub calls in the common (no-gap) case.
- **False negatives on very old issues** → The reconciler caps its comment scan at 20 most-recent comments. An issue with > 20 comments posted after a partial write could miss the search window. This is an acceptable edge case: partial writes are rare and usually repaired within one run.
- **Partial writes before this change ships** → Pre-existing missing comments are not repaired. This is documented as a non-goal.

## Open Questions

- None. The `getIssueDetail` comment shape and `postComment` signature are already confirmed. The sentinel format is additive to the existing comment body and does not break any parsers.
