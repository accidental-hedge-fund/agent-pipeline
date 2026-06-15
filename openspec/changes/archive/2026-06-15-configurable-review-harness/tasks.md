## 1. Generalize invoke() seam

- [x] 1.1 Widen the `harness` parameter of `invoke()` in `harness.ts` from `Harness` to `string`; add the custom-CLI invocation path (prompt as positional argument, stdout captured as output) for values that are not `"claude"` or `"codex"`
- [x] 1.2 Replace `throw new Error("Unknown harness: ${harness}")` with a spawn attempt that, on ENOENT or spawn failure, returns a `HarnessResult` carrying the named error message (e.g. `reviewer CLI '<name>' not found or not executable — ensure it is installed and on PATH`) rather than throwing

## 2. Update invokeReviewer signature

- [x] 2.1 Widen the `reviewer` parameter of `invokeReviewer` in `self-review.ts` from `Harness` to `string`; keep `implementer` as `Harness` (the self-review fallback is always a built-in harness)
- [x] 2.2 Update `selfReviewBanner` and any other callers that reference the reviewer parameter type to accept `string`

## 3. Add review_harness config key

- [x] 3.1 Add `review_harness: z.string().optional()` to `PartialConfigSchema` in `config.ts`
- [x] 3.2 After the profile/file merge in `resolveConfig()`, if `fileConfig.review_harness` is set, overwrite `cfg.harnesses.reviewer` with the value

## 4. Tests

- [x] 4.1 `invoke()` with a non-built-in harness string: spawns the named CLI; a spawn-fail (ENOENT) produces the named error message (not "Unknown harness")
- [x] 4.2 `resolveConfig()`: `review_harness` key parses and overrides `cfg.harnesses.reviewer`; `cfg.harnesses.implementer` is unaffected
- [x] 4.3 `resolveConfig()`: `review_harness` absent → `cfg.harnesses.reviewer` equals the profile default, no warning emitted
- [x] 4.4 `invokeReviewer` with a custom reviewer string: routes through the generalized `invoke()` path; on spawn failure the implementing harness fallback is attempted (as per #39)

## 5. README documentation

- [x] 5.1 Add `review_harness` to the `.github/pipeline.yml` config reference: what it does, its default (profile reviewer), and what a custom reviewer CLI must produce (a fenced JSON block matching the verdict schema the pipeline gates on)

## 6. Mirror + CI

- [x] 6.1 Regenerate the plugin mirror: `node scripts/build.mjs`
- [x] 6.2 Confirm `npm run ci` passes (all tests green, mirror check passes, install smoke passes)
