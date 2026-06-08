## Context

Review verdicts are currently extracted on-demand from GitHub PR comments. The `ReviewVerdict` type (`core/scripts/types.ts:186`) has no `commitSha` field. No pre-check compares the commit that was reviewed against current HEAD before the verdict is acted on. This means if new commits land after a review comment is posted but before the next gate runs, the pipeline advances on a stale approval.

Verdicts are not stored on disk — PR comments are the source of truth. The round-1 summary is read back via `extractReview1Summary()` to provide continuity context for round 2. Any SHA-binding mechanism must work through this same comment-based storage.

## Goals / Non-Goals

**Goals:**
- Embed the reviewed commit SHA in every review comment at post time.
- Re-read the SHA from the comment at gate time and compare to current HEAD.
- Trigger a fresh review run (not a blocked state) when SHA mismatch is detected.
- Surface the short SHA in all review comments for human visibility.
- Zero behavior change when HEAD has not moved.

**Non-Goals:**
- Persisting verdicts to disk or a database.
- Comparing diff hashes (SHA is the identity unit, not the diff).
- Retroactively invalidating verdicts from before this change ships (no migration of old comments without embedded SHA).
- Changing the retry / zero-findings logic in `verdict-normalization`.

## Decisions

### Decision 1: Embed SHA in the comment body, not a separate label or side-channel

**Rationale:** Comments are already the source of truth for verdict state. Adding a machine-readable SHA line to the existing review comment body keeps the extraction logic co-located with `extractReview1Summary()`, avoids a new persistence layer, and is readable by humans without tooling.

**Alternatives considered:**
- Store SHA in a GitHub issue label — labels are visible but can be stripped by other tools and don't version per-round.
- Store SHA in a separate "pipeline metadata" comment — adds a second comment to parse and a race if the metadata comment is deleted.

### Decision 2: Gate check reads SHA from the most recent review comment for that round

**Rationale:** `extractReview1Summary()` already locates the relevant comment by its `## Review 1` marker. The same function (or a sibling `extractReviewSha()`) can extract the embedded SHA from that comment. This reuses the existing comment-scanning infrastructure.

**Alternatives considered:**
- Pass the SHA as an in-memory field through the pipeline run — works within one invocation but does not survive between runs (e.g., a re-trigger after a fix stage).

### Decision 3: SHA mismatch triggers a re-review, not a `blocked` state

**Rationale:** A new commit is expected developer activity. Blocking the item would require human intervention for something the pipeline should handle automatically. Re-review is the correct automated response.

**Alternatives considered:**
- Block and require human re-label — conservative but adds friction for routine development flow.

### Decision 4: Old comments without embedded SHA are treated as stale (re-review)

**Rationale:** A comment with no SHA field cannot be verified as current. The safe default is to re-run rather than trust an unverifiable verdict. This avoids a special legacy-detection code path and the behavior is correct: if we can't verify the commit, we re-review.

## Risks / Trade-offs

- **Extra review invocations when commits land mid-pipeline** → Expected and intentional. Cost is bounded to one re-review per new push that reaches a gate.
- **Race: commit lands between SHA read and re-review** → The re-review will itself record the new HEAD SHA; a subsequent gate will be consistent. No special handling needed.
- **Comment parsing fragility** → The SHA line format must be stable. A regex that is too greedy could match a SHA in the diff body. Mitigation: anchor the pattern to a dedicated sentinel line (e.g., `<!-- reviewed-sha: <sha> -->`).

## Open Questions

- Should the SHA be in an HTML comment (invisible to readers) or a visible footer line? Prefer HTML comment to keep review comment text clean.
- Does round-2 review also need to record a SHA, or is round-1's SHA sufficient for the pre-merge gate? Both rounds should record their own SHA since both can be stale independently.
