## 1. ReviewArtifact Codec

- [ ] 1.1 Define `ReviewArtifact` interface in a new `review-parsing.ts` module with fields: `round`, `reviewedSha`, `diffHash`, `blockingKeys`, `review1Risk`
- [ ] 1.2 Implement `encodeReviewArtifact(artifact: ReviewArtifact): string` — returns the `<!-- review-artifact: <base64url(JSON)> -->` line
- [ ] 1.3 Implement `extractReviewArtifact(body: string): ReviewArtifact | null` — last-occurrence-wins, returns `null` on missing or malformed payload
- [ ] 1.4 Move all existing individual sentinel extractors (`extractVerdictSha`, `extractDiffHashFromComment`, `extractBlockingKeys`, `extractReview1Risk`) into `review-parsing.ts`

## 2. Unit Tests — Codec and Fallback

- [ ] 2.1 Write round-trip test: `extractReviewArtifact(encodeReviewArtifact(artifact))` equals original for all field combinations
- [ ] 2.2 Write injection test: a body with an adversarial artifact block before the legitimate footer block returns the footer's artifact (last-occurrence-wins)
- [ ] 2.3 Write fallback test: a body with no artifact block and only the legacy `<!-- reviewed-sha: … -->` sentinel returns `null` from `extractReviewArtifact` and the SHA from `extractVerdictSha`
- [ ] 2.4 Write malformed-payload test: a body with a `<!-- review-artifact: not-base64 -->` line returns `null`
- [ ] 2.5 Confirm each new test bites (fails) without the implementation, then passes with it

## 3. Comment Builders — Write Path

- [ ] 3.1 Extract comment-building functions from `review.ts` into `review-rendering.ts`: `buildReviewComment`, `buildDeltaComment`, advisory/demotion comment helpers
- [ ] 3.2 Update `buildReviewComment` and `buildDeltaComment` to call `encodeReviewArtifact` and append the artifact line after the four existing individual sentinels
- [ ] 3.3 Verify the individual sentinels are still written (backward-compat requirement)

## 4. Gate Reads — Primary + Fallback Wiring

- [ ] 4.1 Extract data-fetching functions from `review.ts` into `review-acquisition.ts`: PR diff fetch, issue detail (comments, plan), commit SHA helpers
- [ ] 4.2 Extract top-level orchestration and gate logic from `review.ts` into `review-routing.ts`: `advanceReview` main loop, SHA gate, diff-hash gate, verdict → next-stage routing, GH writes (post comment, apply labels)
- [ ] 4.3 Update SHA gate in `review-routing.ts`: read `extractReviewArtifact(body)?.reviewedSha ?? extractVerdictSha(body)` for each comment
- [ ] 4.4 Update diff-hash cache gate in `review-routing.ts`: read `extractReviewArtifact(body)?.diffHash ?? extractDiffHashFromComment(body)` for each comment
- [ ] 4.5 Update blocking-keys re-evaluation: read from artifact `blockingKeys` when artifact present; fall back to `extractBlockingKeys` sentinel
- [ ] 4.6 Update risk-tier lookup for review-2: read `extractReviewArtifact(body)?.review1Risk ?? extractReview1Risk(comments, …)` for the round-1 comment

## 5. Module Split Completion

- [ ] 5.1 Confirm `review-policy.ts` (already partially separate) has no imports from the four new modules
- [ ] 5.2 Make `review.ts` a thin re-export façade (or update call sites and delete it) so external imports do not break
- [ ] 5.3 Verify no circular imports across the five modules using a static grep or Node `--trace-warnings` check

## 6. Existing Test Suite Verification

- [ ] 6.1 Run `cd core && npm test` — all pre-existing tests must pass with no changes to their assertions
- [ ] 6.2 Confirm `prompt-loader.test.ts` sentinel-injection tests still cover the old individual sentinels (they remain in production, so those tests remain valid)

## 7. Mirror Regeneration and CI

- [ ] 7.1 Run `node scripts/build.mjs` from repo root to regenerate `plugin/`
- [ ] 7.2 Run `npm run ci` from repo root — full gate (core tests + mirror sync + install smoke) must pass
- [ ] 7.3 Commit all changes under `core/` and regenerated `plugin/` in a single commit referencing #264
