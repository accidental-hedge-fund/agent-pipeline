# #1098 Plan revision — coverage banner must not break review-artifact bodyHash

## Status
- [x] Plan review feedback incorporated (see chat `## Feedback Incorporated`)
- [x] Implementation: shared finalize + tight strip + tests

## Reviewer feedback dispositions
See chat response `## Feedback Incorporated` (authoritative for this revision).

## Locked decisions (post-review)
1. One exported `finalizeReviewArtifactComment(body, banners)` in `review-parsing.ts`.
2. Call sites: `review-routing.ts` `reviewComment` + both `pre-merge-sha-gate.ts` delta posts.
3. Rebind last `review-artifact` only; exact prefix hash; preserve metadata; reject suffix.
4. Compatibility strip: four production banner forms only, heading → `**Reviewer**:`.
5. Human line among banners, including banner-like markdown, is not stripped.
6. Plan-review and other `pipeline-attest` comments stay out of this change.

## Implementation sequence (post-approval)
1. Export `finalizeReviewArtifactComment`; tighten strip allowlist; lock rebind tests
2. Wire review-routing + both delta posts to the shared finalizer
3. Add composition tests (verify + ack gate + human-among-banners)
4. `node scripts/build.mjs` + `openspec validate` + `npm run ci`
