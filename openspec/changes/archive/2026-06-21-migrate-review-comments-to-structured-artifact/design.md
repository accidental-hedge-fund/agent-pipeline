## Context

`core/scripts/stages/review.ts` (~2 100 lines) encodes gate state into four disjoint HTML-comment sentinels appended to every review comment:

| Sentinel | Regex | Consumer |
|---|---|---|
| `<!-- reviewed-sha: … -->` | `REVIEW_FOOTER` | SHA gate (review-sha-gating) |
| `<!-- verdict-diff-hash: … -->` | `VERDICT_DIFF_HASH_RE` | diff-hash cache (verdict-diff-cache) |
| `<!-- pipeline-blocking-keys: … -->` | `PIPELINE_BLOCKING_KEYS_RE` | pre-merge blocker check |
| `<!-- pipeline-review1-risk: … -->` | `REVIEW1_RISK_RE` | risk-proportional blocking |

Each sentinel has its own extraction function, its own last-occurrence-wins guard, and its own injection-resistance test fixture. The write path appends them independently in `buildReviewComment` / `buildDeltaComment`. Adding a new gate dimension means adding a new sentinel, a new regex, and a new extractor — work that is easy to get wrong and hard to test as a whole.

## Goals / Non-Goals

**Goals:**
- Single `ReviewArtifact` struct that carries all four gate fields (and room for future fields) in one encoded block.
- Primary-over-fallback precedence: gate reads use the struct when present, individual sentinels when not (old comments).
- Module split that breaks the 2 100-line monolith into five focused files, each under ~500 lines.
- No behaviour change observable at the GitHub comment or state-machine level (purely internal).

**Non-Goals:**
- Backfilling historical comments (old comments remain sentinel-only; the fallback path is permanent, not transitional).
- Changing the verdict schema or review-policy logic.
- Changing external `gh` call shapes.
- Removing the legacy sentinel extractors (they remain as fallback and for backward-compat tests).

## Decisions

### 1. Encoding: base64-encoded JSON inside a hidden HTML comment

`<!-- review-artifact: <base64(JSON)> -->` on a single line at the end of the comment footer.

**Why base64 over raw JSON?** Raw JSON embedded in an HTML comment can contain `-->` in string values, which terminates the comment. Base64 is safe.

**Why not a separate GitHub comment?** Adding a comment just to carry metadata costs an extra API call, appears in the UI timeline, and creates a new comment-ordering problem. Embedding in the review comment keeps metadata co-located with its verdict.

**Alternatives considered:**
- URL-encoded JSON: readable but `%`-heavy and can still contain `-->` via multi-byte sequences in edge cases.
- Separate comments: rejected (extra API call, UI noise).

### 2. Last-occurrence-wins injection resistance

The artifact block is anchored to the pipeline-controlled comment footer, written after all reviewer-authored text. Extraction SHALL use last-occurrence-wins semantics (same as the existing individual sentinels): only the final `<!-- review-artifact: … -->` line in the comment is parsed, so an adversary who embeds a malicious block inside the review body cannot override the legitimate footer block.

**Why not first-occurrence?** The reviewer's quoted diff context or body text could contain a `review-artifact` string early in the comment.

### 3. Module split — five files

| File | Responsibility |
|---|---|
| `review-acquisition.ts` | Fetch PR diff, issue detail (comments, plan), commit SHAs. Pure data retrieval; no routing or comment writing. |
| `review-parsing.ts` | All extractors (`extractReviewArtifact`, fallback individual-sentinel extractors), `ReviewArtifact` codec, `parseProseReview`. |
| `review-policy.ts` | (already partially separate) `partitionFindings`, `findingKey`, `overrideMatches`, risk scaling. No imports from the other new modules. |
| `review-rendering.ts` | `buildReviewComment`, `buildDeltaComment`, advisory comment templates, demotion comment helpers. Pure comment-body assembly; no GH writes. |
| `review-routing.ts` | Top-level `advanceReview` orchestrator, SHA gate, diff-hash gate, verdict → next-stage decisions, GH writes (post comment, label). |

`review.ts` becomes a thin re-export façade (or is deleted and callers updated) so external call sites don't break.

**Rationale:** Single-responsibility modules are independently testable. The current file size makes it hard to follow the flow from "we have a verdict" to "we post a comment and route."

### 4. Struct shape

```ts
interface ReviewArtifact {
  round: 1 | 2;
  reviewedSha: string;          // 40-char SHA
  diffHash: string | null;      // 16-char hex or null
  blockingKeys: string[];       // sorted, deduped
  review1Risk: "low" | "standard" | null;  // null for round-2 when not yet known
}
```

All fields that the gate currently reads from individual sentinels. Typed so a missing field surfaces as `null` rather than as an absent sentinel, making the read path explicit about what is and isn't known.

### 5. Fallback precedence rule

```
artifact = extractReviewArtifact(comment.body)
sha      = artifact?.reviewedSha ?? extractVerdictSha(comment.body)
diffHash = artifact?.diffHash    ?? extractDiffHashFromComment(comment.body)
...
```

Each gate field falls back independently so a partial-artifact (e.g., from a future downgrade or truncation) degrades gracefully.

## Risks / Trade-offs

- **Base64 decoding failure** → treat as absent artifact (fallback to sentinels). Never throw on malformed input. This is the same posture as the individual sentinel extractors.
- **Module split merge conflicts** — the split happens in a single PR; the monolithic file has high churn, so conflicts are possible. Mitigation: land this change after any in-flight sentinel-touching work is merged.
- **Injection via reviewer body** → mitigated by last-occurrence-wins (Decision 2 above). The suite's existing injection fixture tests cover this pattern and MUST be extended for the new artifact block.
- **Comment length** — `ReviewArtifact` base64 is ~100 chars per comment. No practical impact on GH comment limits.

## Migration Plan

1. Write `ReviewArtifact` codec and extractors in `review-parsing.ts`.
2. Update comment builders (`review-rendering.ts`) to append the artifact block after the existing four sentinels (not replacing them — additive).
3. Update gate reads in `review-routing.ts` to use `artifact ?? fallback` pattern for each field.
4. Split `review.ts` into the five modules; verify no circular imports.
5. Regenerate `plugin/` mirror (`node scripts/build.mjs`).
6. Run `npm run ci` — all existing tests must pass; new fixture tests must bite without the change.

**Rollback:** The change is purely additive on the write side (new block co-exists with old sentinels) and falls back on the read side. Reverting the read-path change restores old behaviour without touching stored comments.

## Open Questions

- Should `review.ts` remain as a re-export façade or be deleted with call sites updated? (Prefer façade initially to reduce diff size; clean up in a follow-up.)
- Does `review1Risk: null` on a round-2 artifact (when round-1 used legacy sentinels) need a special handling path in risk-proportional blocking, or is the existing `extractReview1Risk` fallback sufficient? (Fallback is sufficient — the null-coalescing pattern covers it.)
