## Context

`runOverride` is a short function: parse the arg, post an override comment, optionally clear `blocked`, then print a prompt for the operator to re-run. The advance loop is invoked by `runAdvance`, which acquires the domain lock, resolves the issue, and iterates through stages.

The only new control-flow is: after posting the sentinel, call `runAdvance` (or inline the loop). The override is already idempotent — re-running `partitionFindings` with the sentinel present is safe regardless of how many times it runs.

The `needs-human` stage is the tricky case. The advance loop today breaks immediately on `needs-human`; it does not dispatch any stage handler. The resume round is encoded in the `## Pipeline: Review ceiling reached` comment body (field `round`). To auto-resume, `runOverride` must (1) read that comment, (2) flip the label to `pipeline:review-<round>`, then (3) enter the advance loop.

## Goals / Non-Goals

**Goals:**
- Collapse the override→re-run two-step into one human action.
- For `needs-human`: automatically flip to `review-<round>` using the round recorded in the ceiling comment, then advance.
- Preserve the fail-safe: if outstanding blockers remain after the override is applied, the loop re-parks at `needs-human` — it never skips an unresolved blocker.
- No-auto-merge invariant is untouched; the loop still stops at `ready-to-deploy`.

**Non-Goals:**
- The pipeline does not author the override text (key + reason stays human-supplied).
- No auto-advance out of `needs-human` except via an explicit `--override` invocation.
- No change to the sentinel format, `partitionFindings`, `review_policy`, or any other stage.

## Decisions

**Decision: `runOverride` calls `runAdvance` after recording the sentinel, not a shared internal helper.**
`runAdvance` acquires the lock and handles all the loop bookkeeping. Reusing it keeps the advance path single-sourced. The slight overhead of a lock re-acquire after `runOverride` already holds no lock is acceptable; `runOverride` does not hold the lock (it is not called inside `withLock`).

**Decision: read the ceiling round from the existing `REVIEW_CEILING_MARKER` comment, not from a new field.**
The round is already stored in the `## Pipeline: Review ceiling reached` comment body. Parsing it from there avoids adding new state or new PR labels. The parse is the same logic already used by `needsHumanPunchlist`.

**Decision: label-flip inside `runOverride` before calling `runAdvance`, not inside the advance loop.**
The advance loop breaks on `needs-human` today (it has no stage handler for it). Rather than adding a handler, do the label flip in `runOverride` — which already knows it is resuming from an override — then let the advance loop start from `review-<round>` normally. This keeps the advance loop's `needs-human` branch unchanged (it remains a break point for non-override entry paths).

**Decision: if no ceiling comment is found when stage is `needs-human`, error out rather than guess a round.**
The ceiling comment is the authoritative source for which review round to resume into. If it is absent, the safe behavior is a clear error message, not a guess. This mirrors the fail-safe philosophy.

## Risks / Trade-offs

- *Lock contention*: `runOverride` runs outside the lock; `runAdvance` re-acquires it. If another agent holds the lock, `runAdvance` will queue. This is the correct behavior (same as a manual re-run) and imposes no new risk.
- *Ceiling comment not found*: `runOverride` errors with a clear message. Operator falls back to the manual two-step. No regression.
- *All remaining blockers resolved by the override → loop advances past needs-human*: This is the intended happy path. The partition is deterministic; the loop stops at `ready-to-deploy` as always.
- *Some remaining blockers → loop re-parks at needs-human*: Fail-safe behavior. The operator must override or fix the remaining findings before the next advance.
