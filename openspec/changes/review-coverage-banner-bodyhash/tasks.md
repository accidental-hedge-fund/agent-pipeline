## 1. Bind bodyHash after the last engine-owned insert

- [ ] 1.1 Make the production review-1 / review-2 / delta post wrapper apply every engine-owned insert (coverage, ensemble identity, self-review), then bind `ReviewArtifact.bodyHash` to the exact posted prefix before GitHub post.
- [ ] 1.2 Do not mutate that hashed prefix after the bind. Do not add an ack-gate exemption keyed on a coverage-banner string or a `## Review` heading.
- [ ] 1.3 Reuse the existing shared bind helper if it already implements last-step rebind. Complete any path (delta, no-banner, ensemble, self-review) that still posts a stale hash.
- [ ] 1.4 Keep coverage disclosure on the posted body. Do not delete the #694 banner.

## 2. Verification: new posts exact-prefix; old posts strip-only

- [ ] 2.1 `isVerifiedPipelineReviewOutput` SHALL return true for a newly wrapped review-1, review-2, and delta body on the exact prefix (no strip required).
- [ ] 2.2 Keep or add a compatibility strip that retries the hash after removing only documented engine-owned banner lines between the heading and `**Reviewer**:`.
- [ ] 2.3 A human objection line in that slot SHALL still fail verification.

## 3. Ack-gate composition tests

- [ ] 3.1 Unit-test: `formatReviewComment` plus the production coverage wrapper → `isVerifiedPipelineReviewOutput` true and `isVerifiedPipelineOutput` true.
- [ ] 3.2 Unit-test: the same wrapper on `formatDeltaReviewComment` also verifies.
- [ ] 3.3 Unit-test: that verified review-2 body plus `\binstead\b` in finding text is **not** returned by `findUnacknowledgedComments` when the author is the pipeline actor.
- [ ] 3.4 Unit-test: a free-form human comment after the revised plan **is** still returned.
- [ ] 3.5 Unit-test: a human objection inserted into a review prefix (not an engine-owned banner) fails verification and is still counted when it matches `NEGATION_PATTERNS`.
- [ ] 3.6 Tests inject deps. No real network, git, or subprocess.

## 4. Mirror and gate

- [ ] 4.1 If `core/` changed, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit.
- [ ] 4.2 Run `npm run ci` and fix any failures until green.
