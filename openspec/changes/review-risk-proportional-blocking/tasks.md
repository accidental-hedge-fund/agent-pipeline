## 1. Config: `review_policy.risk_proportional`

- [ ] 1.1 Add `risk_proportional: boolean` to the `review_policy` type in `core/scripts/types.ts` and set it to `false` in `DEFAULT_CONFIG.review_policy`.
- [ ] 1.2 Add the schema field in `core/scripts/config.ts` (`z.boolean().optional()` with a description), default `false`, and wire it through config resolution next to `block_threshold` / `min_confidence`.
- [ ] 1.3 Add `"review_policy.risk_proportional"` to `RIGOR_GATING_PATHS` in `config.ts`.
- [ ] 1.4 Document `risk_proportional` under `review_policy` in `.github/pipeline.yml` (commented default `false`, one-line explanation of risk-proportional blocking).

## 2. Capture the `review-1` risk signal

- [ ] 2.1 Add a structural risk classifier: `review-1` is `low` when the verdict is `approve` with zero findings, else `standard`.
- [ ] 2.2 Emit a `<!-- pipeline-review1-risk: low|standard -->` sentinel on the `review-1` comment (in/around `formatReviewComment` / the review-1 posting path in `stages/review.ts`).
- [ ] 2.3 Add `extractReview1Risk(comments)` returning `"low" | "standard"`, reading the latest sentinel and defaulting to `"standard"` when absent/unrecognized.

## 3. Effective-threshold scaling

- [ ] 3.1 Add `effectiveReviewPolicy(policy, { round, review1Risk })` to `review-policy.ts`: returns `policy` unchanged unless `round === 2 && policy.risk_proportional && review1Risk === "low"`, in which case it returns a clone whose `block_threshold` is the stricter of the configured threshold and `"high"` (`min_confidence` unchanged).
- [ ] 3.2 In `stages/review.ts`, at `round === 2`, read the captured `review-1` risk and pass `effectiveReviewPolicy(...)` into the existing `partitionFindings(...)` call site instead of `cfg.review_policy`.

## 4. Tests

- [ ] 4.1 `effectiveReviewPolicy` unit tests: flag off → unchanged; round 1 → unchanged; round 2 + low + flag on with `block_threshold` `low`/`medium` → `high`; with `high` → `high`; with `critical` → `critical`; round 2 + standard risk → unchanged.
- [ ] 4.2 Risk classifier + sentinel round-trip: `approve`/0-findings → `low` sentinel emitted; `extractReview1Risk` recovers it; missing/garbled sentinel → `standard`.
- [ ] 4.3 Regression (a): low-risk `review-1` + medium `review-2` finding + flag on → advances as advisory (no fix route).
- [ ] 4.4 Regression (b): standard-risk `review-1` + medium `review-2` finding + flag on → still routes to `fix-2`.
- [ ] 4.5 Regression (c): flag off + low-risk + medium finding → still routes to `fix-2` (behavior identical to today).
- [ ] 4.6 Regression (d): low-risk + flag on + **high** `review-2` finding → still blocks.
- [ ] 4.7 Prove each regression bites: it fails against the pre-change behavior.

## 5. Mirror + CI

- [ ] 5.1 Run `node scripts/build.mjs` to regenerate the `plugin/` mirror; commit it in the same change.
- [ ] 5.2 Run `npm run ci` from the repo root; all checks green (`review-schema.test.ts` drift-guard stays green — no schema field added).
