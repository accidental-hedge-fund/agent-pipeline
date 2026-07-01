## Why

The OpenSpec consistency guard (`enforceSpecConsistencyGuard`, `core/scripts/openspec-consistency.ts`; shipped as code in #106/#113) exists to stop a stale spec delta from being archived into the living specs. It blocks when BOTH (1) a developer/fix commit changed implementation files in a commit ordered after the last `specs/**` change (`specDeltaIsStale`), AND (2) the most recent review verdict carries a `category: spec-divergence` marker.

Those two conditions are true for two *different* situations that the guard cannot tell apart:

- **Code is behind an already-correct spec.** The active OpenSpec delta already describes the desired behavior; review flags the implementation for violating it; the correct fix changes implementation. This is the normal, expected fix-round path.
- **The spec delta is behind accepted code.** The accepted current behavior has moved beyond what the delta states; archiving would fold a wrong requirement into `openspec/specs/`.

Because the guard treats every `spec-divergence` finding plus a code-changed-last file order as "stale delta", it forces a human `openspec-stale-delta` blocker onto the first situation. `PraxisIQ/contractiq-core#849` hit exactly this: the active spec already required per-contract chat isolation, review 2 flagged the implementation for violating that requirement, the `fix-2` round correctly changed implementation only — and the pipeline blocked for human spec repair even though the spec was already right. It also decides on a *pre-fix* review marker that the fix round may have already resolved, rather than the current post-fix state.

## What Changes

- **Disambiguate direction before acting.** The guard SHALL classify an unresolved spec-divergence as either *code-behind-spec* (implementation must change — a normal fix round) or *spec-behind-code* (the active delta is stale) from a structured signal, never from reviewer prose (preserving the #106 discipline). Absent positive evidence that the delta itself is stale, the guard SHALL NOT force spec repair and SHALL NOT block a fix round solely because implementation files changed after the last spec edit.
- **Decide on post-fix state.** The stale-delta decision SHALL reflect the current post-fix head, not a pre-fix review marker a later fix round may have resolved.
- **Bounded, verifiable spec-only repair before blocking.** When — and only when — there is positive evidence the active delta is stale, the pipeline SHALL make exactly one automatic spec-delta repair attempt before blocking, provided the repair can be verified without changing application code. The repair may touch only the active change's `specs/**` and `tasks.md`, must pass `openspec validate <change-id>`, must be committed with the run's traceability trailers, and must re-run the stale-delta guard once before the run advances.
- **Direction-specific blocking.** If the repair attempt fails, changes disallowed files, produces invalid OpenSpec, or still leaves the state stale, the pipeline SHALL block with a reason that says whether the remaining work is *code alignment* or *spec-delta alignment*.
- **No weakening of archive safety.** The guard stays active at fix-round and pre-merge/archive time; a genuinely stale delta is still never archived into the living specs.

## Capabilities

### New Capabilities

- `openspec-divergence-disambiguation`: The consistency guard distinguishes code-behind-spec from spec-behind-code on a structured, post-fix signal; only spec-behind-code triggers spec-delta work; a single bounded, code-frozen, validated spec repair is attempted before a direction-specific block.

### Modified Capabilities

- None. The guard's base blocking behavior is not yet in the living specs — it is described only by the still-active change `fix-round-spec-delta-consistency` (see the conflict noted in `design.md`). This change ADDS the disambiguation layer as its own capability rather than MODIFYING a requirement that does not yet exist in `openspec/specs/`.

## Acceptance Criteria

- [ ] When review flags the implementation for violating an existing active OpenSpec requirement and a later fix-round commit changes only implementation/test files to satisfy it, the guard does not block solely because implementation files changed after the latest spec-delta edit.
- [ ] The stale-delta decision is computed from the current post-fix state, not only from a pre-fix review marker that a fix round may have resolved.
- [ ] The pipeline determines and records whether the unresolved problem is "implementation still diverges from the active spec" (code-behind-spec) or "the active spec delta is stale relative to accepted current behavior" (spec-behind-code).
- [ ] The pipeline requires or attempts spec-delta repair only when there is positive structured evidence that the active delta itself no longer describes accepted current behavior; an ambiguous or unclassified `spec-divergence` finding does not force spec repair.
- [ ] When the active delta is genuinely stale, the pipeline makes exactly one bounded automatic spec-delta repair attempt before blocking, and only when that repair can be verified without changing application code.
- [ ] A bounded spec-delta repair updates only the active change's `specs/**` requirements and `tasks.md`, passes `openspec validate <change-id>`, is committed with the run's `Issue:`/`Pipeline-Run:` traceability trailers, and re-runs the stale-delta guard exactly once before the run advances.
- [ ] If the repair fails, touches any disallowed file (application code), produces invalid OpenSpec, or still leaves the current state stale, the pipeline blocks with an actionable reason that states whether the remaining work is code alignment or spec-delta alignment.
- [ ] A regression test reproduces the #849 shape (active spec already requires the behavior, review flags the implementation, fix changes implementation only) and asserts the pipeline advances instead of posting an `openspec-stale-delta` human blocker.
- [ ] A regression test reproduces a true stale-delta shape (accepted behavior moved beyond the delta) and asserts the stale delta is not archived and that either verified spec repair succeeds or the run blocks before archive.
- [ ] The stale-delta guard remains active at both fix-round and pre-merge/archive time; `npm run ci` (including `openspec validate --all`) passes.

## Impact

- `core/scripts/openspec-consistency.ts` (guard: direction classification, post-fix evaluation, bounded repair orchestration, direction-specific block reasons), `core/scripts/review-policy.ts` (structured direction signal alongside the existing `category` marker), `core/scripts/prompts/{review_standard.md,review_adversarial.md}` + `index.ts` (reviewer emits the direction), `core/scripts/stages/{fix.ts,pre_merge.ts}` (guard call sites), and co-located tests.
- No new state-machine edges. The human-owned merge boundary is unchanged. The guard is narrowed, not removed.
