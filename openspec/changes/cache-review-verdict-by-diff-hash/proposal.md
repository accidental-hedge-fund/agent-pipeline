## Why

The adversarial reviewer is non-deterministic: re-reviewing an identical diff produces different findings each pass. Two pipeline paths invoke the reviewer redundantly on already-evaluated code — override re-entry and ceiling resume re-run review on a frozen diff, minting fresh finding keys that invalidate previously-applied overrides so convergence is impossible; and the pre-merge SHA gate routes back to a full adversarial round whenever any fix commit lands, burning round budget toward the ceiling on code the reviewer already approved.

## What Changes

- Embed a `<!-- verdict-diff-hash: <hash> -->` sentinel in every review comment, keying the verdict to a hash of the PR diff content at review time.
- On re-entering a review stage, compute the current PR diff hash. If it matches the sentinel in the prior review-N comment, return the cached verdict without invoking the reviewer.
- Extend `enforceReviewShaGate` in the pre-merge stage with a diff-hash check: a SHA mismatch where the full diff hash is unchanged reuses the prior verdict (no re-review needed); a mismatch where the diff changed triggers a focused delta review (adversarial review of `last-reviewed-sha...HEAD` only) rather than routing back to a full review-2 round.

## Capabilities

### New Capabilities
- `verdict-diff-cache`: Review verdicts are cached per review round keyed by a hash of the PR diff content; re-entering a review stage on an unchanged diff returns the cached verdict without invoking the reviewer.
- `pre-merge-delta-recheck`: When the pre-merge SHA gate detects HEAD moved with non-archive commits, it checks the diff-hash cache first; on a cache hit the verdict is reused; on a miss the unreviewed delta (`last-reviewed-sha...HEAD`) is reviewed adversarially rather than routing back to a full review-2 round.

### Modified Capabilities
- `review-sha-gating`: The SHA mismatch path is extended: a mismatch with unchanged diff hash reuses the cached verdict; a mismatch with changed diff hash triggers the pre-merge delta-recheck path instead of a full review-2 round.

## Impact

- `core/scripts/stages/review.ts` — embed diff hash sentinel in comment footer; check cache on re-entry before invoking reviewer
- `core/scripts/stages/pre_merge.ts` — extend `enforceReviewShaGate` with diff-hash check and delta review invocation; extend `ShaGateDeps` with `getPrDiff` seam
- Co-located tests for hash computation, cache lookup, gate diff-hash path, and delta review routing
