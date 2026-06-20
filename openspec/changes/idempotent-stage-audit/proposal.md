## Why

GitHub label mutations and comment posts are two separate network calls — and they are not atomic. `transition()` in `core/scripts/gh.ts` first edits labels (`gh issue edit --remove-label … --add-label …`) and then posts a transition comment via `postComment`. `setBlocked()` follows the same pattern: it adds the `pipeline:blocked` label and then posts the blocker body comment. If the label write succeeds but the subsequent comment post fails (transient network error, rate limit, timeout), the issue lands in a partially-written state:

- The label reflects the new stage or blocked condition — the orchestrator will behave accordingly on the next invocation.
- The audit comment is missing — operators cannot see *when* the transition happened, *which run* drove it, or *why* the issue is blocked.

Currently the pipeline has no mechanism to detect or repair this gap. A silent partial write means audit history is unreliable, and a blocked issue may show no comment at all, making it opaque to the issue author.

## What Changes

1. **Comment idempotency key**: embed a run-scoped idempotency marker (run ID + target state) in the body of each transition and blocker comment. This is a lightweight sentinel string that the reconciler can search for.

2. **Retry with backoff**: wrap the comment-post in `transition()` and `setBlocked()` with a small in-process retry loop (distinct from `ghRun`'s existing rate-limit retry, which covers the transport layer). This catches transient failures before they become a reconciliation problem.

3. **Reconciliation on next run**: at the start of each pipeline dispatch, after resolving the issue's current stage, inspect recent comments for the expected idempotency marker. If the marker is absent and the state indicates a transition or block was recorded (label present, comment missing), post the repair comment. Surface the gap as a warning in the run log so operators know a reconciliation occurred.

4. **No duplicate guard**: if a comment with the matching marker already exists (e.g. the original post succeeded but the caller crashed before acknowledging it), skip re-posting.

## Capabilities

### New Capabilities

- `idempotent-stage-audit`: Transition and blocker writes SHALL be idempotently auditable. Each transition and blocker comment SHALL embed a run-scoped idempotency key. A later run SHALL detect and repair a missing audit comment. Duplicate comment posting SHALL be suppressed when the marker already exists.

### Modified Capabilities

- `pipeline-state-machine` (within the existing blocked-state requirement): The `setBlocked` write path SHALL be retry-wrapped and embed an idempotency key so the blocked comment is recoverable if the first post fails.

## Impact

- `core/scripts/gh.ts` — `transition()` and `setBlocked()` gain a retry wrapper on the comment-post step and embed an idempotency key in the comment body.
- `core/scripts/pipeline.ts` (or a new reconcile helper) — reconciliation logic runs per dispatch: reads recent comments, detects a missing marker, and posts the repair comment.
- `core/test/` — new unit tests covering: label-edit succeeds + comment-post fails (partial state), retry repairs it in-process; next-run reconciler detects missing marker and posts repair; reconciler skips when marker already present.
- No changes to the label schema, stage sequence, `STAGES`, or the review/fix round logic.

## Acceptance Criteria

- [ ] `transition()` embeds a run-scoped idempotency key (containing the run ID and target stage name) in the body of every transition comment it posts.
- [ ] `setBlocked()` embeds a run-scoped idempotency key (containing the run ID and `blocked`) in the body of every blocker comment it posts.
- [ ] When the comment post in `transition()` or `setBlocked()` fails with a transient error, the call is retried with exponential backoff before propagating; at least two retry attempts are made within a reasonable timeout.
- [ ] When a retry succeeds, no duplicate comment is posted; the function resolves exactly once.
- [ ] At the start of each pipeline dispatch, a reconciler checks whether the current label state (stage or blocked) has a matching idempotency-keyed comment. If not, it posts the missing comment and logs a warning.
- [ ] The reconciler is a no-op when the expected comment is already present (idempotent: never posts a second copy of the same marker).
- [ ] Unit tests exist for the partial-write scenario: label edit succeeds, first comment post fails, retry (or next-run reconciler) posts the repair comment exactly once.
- [ ] Unit tests confirm no duplicate comments are posted when the marker already exists.
- [ ] `npm run ci` passes with no regressions.
