## Why

Since OpenSpec authoring moved into the planning phase, the change's spec deltas are frozen at planning time — but fix rounds only edit code, so a material review finding can cause the implementation to diverge from its own spec, and a stale delta is silently archived into the living specs at pre-merge. The primary harm is living-spec corruption; the secondary harm is reviewer-vs-stale-spec churn from the #16 SHA gate re-anchoring on a now-wrong delta.

## What Changes

- `core/scripts/prompts/fix.md` + `index.ts`: add an OpenSpec-conditional instruction permitting and instructing the fix harness to update the active change's `specs/**` (and `tasks.md`) when a finding's fix changes behavior they describe, then re-run `openspec validate <id>`; reframe the injected spec section from "must satisfy" to "must stay consistent with".
- `core/scripts/stages/fix.ts`: after a fix harness runs, if it revised any `specs/**` files, run `openspec validate <id>` and block the round on a structural failure.
- `core/scripts/stages/pre_merge.ts` (`maybeArchiveOpenspec`): before `openspec archive`, run a consistency guard — detect "code moved, spec didn't" via a deterministic git file-path check AND a review finding tagged **`category: spec-divergence`** (the structured field emitted by `formatReviewComment`); block rather than archive a stale delta. **The guard reads the structured category marker, never the reviewer's free-text prose** — prose keyword-matching is adversarially unwinnable.

## Capabilities

### New Capabilities
- `openspec-fix-round-spec-revision`: Fix rounds are permitted and instructed to revise the active change's spec deltas when a finding implies a behavioral change; the revised delta is validated before advancing.

### Modified Capabilities
- `openspec-integration`: The pre-merge archive step gains a consistency guard that SHALL block on "code moved, spec didn't" divergence — keyed on a deterministic file-path signal and a structured `category: spec-divergence` finding — before folding the change into the living specs.

## Impact

- `core/scripts/prompts/{fix.md,index.ts}`, `core/scripts/stages/{fix.ts,pre_merge.ts,review.ts}`, `core/scripts/review-policy.ts` (structured `category` marker), and co-located tests.
- No changes to the state-machine edges or any other pipeline stage.
