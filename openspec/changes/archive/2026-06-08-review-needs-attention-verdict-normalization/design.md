## Context

`advanceReview` in `review.ts` has two parse paths:
1. **Structured**: `parseStructuredVerdict` finds fenced or inline JSON containing `"verdict"`, returns `{ verdict, summary, findings, next_steps }`.
2. **Fallback**: no valid JSON found → `parseTextVerdict` (conservative, defaults to `"needs-attention"`) + `findings: []` + `_raw: output`.

The routing logic that follows (`verdict === "approve"` → advance to next review; otherwise → fix stage) never checks `findings.length`. A fallback-path verdict silently looks identical to a genuine "needs-attention" verdict with real findings, and the fix stage is invoked on nothing.

There is no log or comment distinction between a real structured `needs-attention` and a fallback-produced one, so operators cannot tell from the pipeline comment which occurred.

## Goals / Non-Goals

**Goals:**
- Prevent the fix stage from being invoked when `findings.length === 0` on a `needs-attention` verdict.
- Provide a single re-review attempt before blocking, because a transient parse failure (race on output, truncation) shouldn't permanently block a PR.
- Make silent fallback visible: log a warning and always include `_raw` in the PR comment when `parseStructuredVerdict` takes the text path.
- Regression-test coverage for both the normalization gate and the two parse paths.

**Non-Goals:**
- Changing the reviewer prompt or companion plugin behavior (out of scope per issue).
- Broader review severity policy or audited-override workflows (see #17).
- Retrying the full review more than once (one re-review is the decided ceiling).

## Decisions

### Decision 1: Re-review once; then BLOCK (not approve)

**Chosen**: if re-review also yields `needs-attention`+0 findings, call `setBlocked` and surface `_raw`.

**Alternative considered — auto-approve on second failure**: rejected because the standard-review text-path can silently drop prose findings (the fallback discards structure). Approving would mask real issues flagged as unstructured prose.

**Alternative considered — block immediately on first 0-findings**: rejected because a single transient parse failure (e.g. truncated stdout) would permanently stall a PR. One re-review is cheap and recovers transient failures.

### Decision 2: Track re-review state via in-memory counter, not a new label

**Chosen**: `advanceReview` accepts an optional `retryCount` parameter (defaults 0). When it reaches 1 and verdict is still `needs-attention`+0 findings, block. The caller (`pipeline.ts`) passes `retryCount: 1` on the re-invocation.

**Alternative considered — new pipeline label like `review-1-recheck`**: adds label churn, requires label creation, and complicates the state machine. The simpler in-parameter approach keeps the state machine graph unchanged.

### Decision 3: Log fallback at the point of parse, not at the routing site

**Chosen**: emit `console.warn("[pipeline] warning: verdict fallback — no structured JSON found in reviewer output")` inside `parseStructuredVerdict` when the text-based path is taken. This makes the warning appear even in test/dry-run runs and is closest to the event.

**Alternative considered — log at routing site**: routing logic would need to inspect `_raw` to distinguish real structured vs fallback, coupling two layers unnecessarily.

## Risks / Trade-offs

- **[Risk] Re-review invocation doubles harness cost for parse failures** → Mitigation: one retry is the ceiling; genuine structured verdicts (the happy path) are unaffected.
- **[Risk] `retryCount` parameter changes the `advanceReview` signature** → Mitigation: default to 0, so all existing callers are unaffected without changes.
- **[Risk] Blocking on re-review failure creates manual intervention burden** → Mitigation: the block comment surfaces the full `_raw` output so operators can see whether the reviewer had real findings and decide manually.

## Open Questions

(none — decision locked per issue #45 pinned comment)
