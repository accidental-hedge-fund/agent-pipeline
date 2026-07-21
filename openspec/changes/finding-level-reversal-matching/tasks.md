## 1. Reproduce the mis-fire

- [ ] 1.1 Add a failing regression fixture in `core/test/review-policy.test.ts`: a digest whose
      round-1 blocking finding on surface `S` is `resolved-by-fix`, plus a round-2 HIGH/0.99 finding
      on `S` describing a distinct defect with no `prior_round_acknowledgment`. Assert it blocks;
      confirm the test fails today (it is demoted).

## 2. Settled findings accessor

- [ ] 2.1 In `core/scripts/review-history.ts`, add a `SettledFinding` record (`key`, `surface`,
      `title`, `round`) and a pure `settledFindings(digest)` accessor keeping the existing
      "latest resolution is `resolved-by-fix` or `overridden`" definition, per finding.
- [ ] 2.2 Retire `settledSurfaces` (and `settledSurfaceRounds` if it has no remaining consumer) once
      call sites move, or keep only what other code still needs; do not leave two parallel notions
      of "settled" in the module.

## 3. Re-raise matcher

- [ ] 3.1 Add `titleSimilarity(a, b)` (normalize: lower-case, strip punctuation, drop stopwords;
      Jaccard over token sets) and an exported threshold constant.
- [ ] 3.2 Add `matchSettledFinding(finding, settled[])` returning the matched entry plus the match
      basis (`"key"` | `"title-similarity"`), or `null`. Enforce: surface must match (or, for an
      entry with no surface, key equality alone); titles that are absent/`(title unavailable)` are
      ineligible for the similarity branch.
- [ ] 3.3 Unit-test the matcher: #395 pair below threshold, restatement above threshold, key match
      across differing line band/severity, surface-only non-match, titleless legacy entry.

## 4. Partition guard

- [ ] 4.1 Change `partitionFindings`'s seventh parameter from `Set<string>` to
      `SettledFinding[]` (default `[]`) and replace the surface-membership test with
      `matchSettledFinding`.
- [ ] 4.2 Return enough match detail for the audit trail (matched entry + basis) alongside the
      advisory reason without changing the reason string `reversal-unacknowledged`.
- [ ] 4.3 Update existing guard tests in `core/test/review-policy.test.ts` and
      `core/test/pre-merge-autofix.test.ts` that assume surface-level matching.

## 5. Audit trail

- [ ] 5.1 `core/scripts/stages/review-routing.ts`: build demotion records from the matcher result;
      extend the `reversal_unacknowledged` event with `settled_finding_key` and `matched_by`.
- [ ] 5.2 `core/scripts/run-store.ts`: widen the event type and its doc comment.
- [ ] 5.3 `core/scripts/stages/review-rendering.ts`: render the tag as
      `REVERSAL-UNACKNOWLEDGED: re-raises <key> "<title>" settled in round N` in both call sites.
- [ ] 5.4 Test the rendered tag and the emitted event fields.

## 6. Prompt wording

- [ ] 6.1 Update `core/scripts/prompts/review_adversarial.md` and the digest rendering in
      `review-history.ts` to say "settled finding", and state that a new, distinct defect on the
      same file/surface needs no acknowledgment.
- [ ] 6.2 Update the `prompt-loader.test.ts` drift guard assertions to pin the new wording.

## 7. Gate

- [ ] 7.1 Re-run the step-1 regression plus the oscillation replays (castrecall-#5 / castrecall-#61)
      and confirm both directions hold.
- [ ] 7.2 `node scripts/build.mjs` to regenerate `plugin/`; commit the mirror in the same change.
- [ ] 7.3 `npm run ci` green from the repo root.
