## 1. Policy module

- [x] 1.1 `core/scripts/review-policy.ts`: severity ordering, content-addressed `findingKey`,
      `partitionFindings` (blocking/advisory/overridden), `extractOverrides`, `parseOverrideArg`,
      `overrideComment`.

## 2. Config

- [x] 2.1 `review_policy` added to `PipelineConfig` + `DEFAULT_CONFIG` (`block_threshold: "low"`,
      `min_confidence: 0`).
- [x] 2.2 zod schema (strict) + `resolveConfig` merge + scaffold template in `config.ts`.

## 3. Routing + overrides

- [x] 3.1 `advanceReview` partitions findings; all-advisory/overridden → advance with an audited
      comment; otherwise route to fix on the blocking subset.
- [x] 3.2 `formatReviewComment` surfaces each finding's override key.
- [x] 3.3 `--override "<key>: <reason>"` CLI in `pipeline.ts` posts the audited sentinel + clears
      `blocked` if set.

## 4. Tests + mirror

- [x] 4.1 `core/test/review-policy.test.ts` (keys, partition, overrides, arg parsing).
- [x] 4.2 `core/test/review.test.ts` extended (all-advisory advances; override advances).
- [x] 4.3 `core/test/config.test.ts` extended (review_policy defaults / merge / strict rejection).
- [x] 4.4 Regenerate `plugin/` mirror (`node scripts/build.mjs`); `npm run ci` green.
