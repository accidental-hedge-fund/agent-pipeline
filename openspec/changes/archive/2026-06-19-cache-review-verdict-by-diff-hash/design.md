## Context

`advanceReview` (review.ts) always invokes the reviewer fresh on every call — there is no "same diff as last time, skip" path. `enforceReviewShaGate` (pre_merge.ts) exempts only OpenSpec archive commits from triggering a re-review; any other commit (including pipeline-authored fix commits) routes the issue all the way back to review-2 for a full adversarial re-run.

The adversarial reviewer is intentionally non-deterministic: it explores a large problem space and different runs surface different findings. This is a feature in normal review rounds. It becomes a defect in two failure paths:

1. **Override re-entry / ceiling resume on frozen diff.** The issue re-enters a review stage with no new code. SHA unchanged → the `reviewed-sha` sentinel matches HEAD → the SHA gate returns null → but `advanceReview` is still called, runs the reviewer again on identical code, and emits different finding keys. The overrides logged against the old keys no longer match. Convergence is impossible.

2. **Pre-merge bounce on fix commit.** A fix commit (pipeline or human) lands after review-2 approves. SHA changed → SHA gate fires → full adversarial re-review of the entire PR diff. The reviewer produces new findings in code it already approved. These findings route to another fix round, which produces another fix commit, which triggers another full re-review. Each cycle burns round budget.

## Goals / Non-Goals

**Goals:**
- Re-entering a review stage on an unchanged PR diff returns the cached verdict without invoking the reviewer (deterministic; overrides stay valid).
- The pre-merge SHA gate uses the diff-hash cache as a second check before triggering re-review.
- When re-review is necessary (diff changed), scope it to the unreviewed delta rather than the full PR diff.
- Rigor is preserved: the delta still goes through the adversarial reviewer.

**Non-Goals:**
- Removing or demoting the adversarial review round.
- Caching across different PRs or issues.
- Semantic deduplication of findings across different diff states.
- Introducing a new ceiling counter for delta reviews (delta reviews are pre-merge sub-checks, not main-round iterations).

## Decisions

**Decision: Hash the raw PR diff string returned by `getPrDiff`.**
`getPrDiff` returns the GitHub-normalized PR diff. SHA-256 of this string (first 16 hex chars for comment brevity) is stable and deterministic. Alternative considered: hash only the `+`/`-` lines (strip diff headers). Rejected: header stripping adds complexity with no practical benefit — GitHub's diff headers are stable for the same content and the sentinel is short enough for a comment footer.

**Decision: Embed `<!-- verdict-diff-hash: <hash> -->` in the review comment footer.**
Follows the existing sentinel pattern (`reviewed-sha`, `pipeline-blocking-keys`). Extraction uses the same "LAST occurrence wins" regex to guard against reviewer-authored body text that might contain a spoofed sentinel earlier in the comment.

**Decision: On diff-hash cache hit, skip the reviewer invocation entirely and return the prior verdict.**
The hash guarantees identical code under review. Running the reviewer again adds non-deterministic noise, not signal. Conservative failure mode: if the comment is malformed or the hash can't be extracted, treat as a cache miss and invoke the reviewer normally.

**Decision: Layered pre-merge re-review checks in `enforceReviewShaGate`.**
Three ordered checks before triggering a re-review: (1) pipeline-internal commit exemption (existing behavior, preserved unchanged); (2) diff-hash cache — SHA mismatch but same full diff → verdict valid; (3) delta review — diff changed, run adversarial review against `last-reviewed-sha...HEAD` instead of routing back to review-2. Each layer is a strict superset of the prior: layers remain independent and composable.

**Decision: Delta review reviews `git diff reviewed-sha...HEAD`, not the full PR diff.**
The full PR diff was already reviewed and approved. The delta is the only unreviewed code. Reviewing the full diff again reintroduces the non-determinism problem. Delta scope is tighter: the reviewer sees only new commits and can focus on whether they introduce issues not present in the approved code.

**Decision: Delta review is an in-place pre-merge sub-check, not a routed review-2 round.**
It uses the adversarial reviewer and round-2 prompt, but runs inline in `enforceReviewShaGate` rather than transitioning to the `review-2` stage. This means: (a) it does not consume a review-2 ceiling slot; (b) a blocking delta finding routes to a fix round via the normal pre-merge blocking path (not via review-2 routing); (c) the delta-review comment carries a new SHA sentinel and diff-hash sentinel so the next pre-merge entry can detect the verdict covers the new HEAD.

**Decision: Deps/fake seam pattern for testability.**
`getPrDiff` is added to `ShaGateDeps`; `runDeltaReview` (or equivalent) is injectable. All new branches are unit-tested with fakes — no real GitHub API, git, or reviewer calls in tests.

## Risks / Trade-offs

- *Delta review misses cross-file interactions between delta and previously-reviewed base*: The adversarial reviewer sees only the delta diff. If the delta interacts with base code in a subtle way, that interaction might be missed. Mitigation: the delta review prompt SHALL state "reviewing unreviewed changes since last approval; the full PR diff was previously reviewed and approved" so the reviewer can reason about context even from the diff alone. If proven insufficient, a future improvement can supply the full diff as background context with the delta highlighted.

- *Rebased/force-pushed branch with same file content but new SHAs*: The full diff hash will be identical → cache hit → no re-review. This is the correct behavior: the code is identical; the verdict is valid.

- *Hash collision*: 16 hex chars = 64 bits. Probability of accidental collision between two different PR diffs ≈ negligible. Not a practical risk.

- *Delta review is blocked by `max_adversarial_rounds` ceiling*: Delta reviews are pre-merge sub-checks, not round-2 iterations, so they are independent of the round ceiling. However, if a delta review finding routes to fix-2 and a subsequent pre-merge entry triggers another delta review, those sub-checks accumulate. A future safety valve may cap total delta reviews per issue; deferred for now.
