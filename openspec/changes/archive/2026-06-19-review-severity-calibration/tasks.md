## 1. Re-anchor the severity rubric (LOW is real)

- [ ] 1.1 Edit `SEVERITY_RUBRIC` in `core/scripts/prompts/index.ts`: expand the **low** bullet to
      explicitly name defensive hardening, observability gaps, minor inconsistencies, narrow
      edge-case nitpicks, and "the next variant of a class already fixed this round."
- [ ] 1.2 Add an explicit anti-inflation directive to the rubric ("these classes are LOW, not
      MEDIUM — do not round up to make a hardening note block").
- [ ] 1.3 Add at least one concrete LOW example (a hardening / nitpick finding) so the model has
      a pattern to imitate.
- [ ] 1.4 Add a test asserting `SEVERITY_RUBRIC` contains the LOW class names and the
      anti-inflation directive (prevents silent regression of the calibration text).

## 2. Non-blocking marker on the verdict schema

- [ ] 2.1 Add `blocking?: boolean` to `ReviewFinding` in `core/scripts/types.ts` with a comment
      explaining: absent/`true` = classify normally; `false` = advisory regardless of severity.
- [ ] 2.2 Add `"blocking": true | false` to the `findings[]` object in
      `REVIEW_VERDICT_SCHEMA_BLOCK` (`core/scripts/review-schema.ts`).
- [ ] 2.3 Add `blocking: true` to `FINDING_FIELD_GUARD` so `REVIEW_SCHEMA_FIELDS.finding`
      enumerates the new field.
- [ ] 2.4 Extend the drift-guard test (`core/test/review-schema.test.ts`) to a third type-token
      category: a TS `boolean` field maps to the unquoted `true | false` hint. Assert the new
      field passes and that a type↔block mismatch fails.

## 3. Policy treats a marked finding as advisory

- [ ] 3.1 In `partitionFindings` (`core/scripts/review-policy.ts`), move any finding with
      `blocking === false` into `advisory` (reason: "marked non-blocking by reviewer") before the
      severity/confidence classification, so it is advisory even at `critical`/`high`.
- [ ] 3.2 Exclude `blocking === false` findings from the `blockingFingerprintsByKey` blocking-
      candidate pre-pass so they cannot inflate a key's distinct-candidate count or affect the
      key-override ambiguity guard.
- [ ] 3.3 Confirm the all-advisory advance comment path (`core/scripts/stages/review.ts`)
      itemizes the non-blocking finding via the existing advisory itemization (no behavior change
      needed if it already iterates `partition.advisory`).

## 4. Reviewer guidance: when to mark non-blocking

- [ ] 4.1 Add a single-sourced constant (mirroring `CONFIDENCE_CALIBRATION_BLOCK`) in
      `index.ts` documenting when to set `blocking: false` — out-of-scope, pre-existing,
      informational — and that the reason goes in the finding `body`.
- [ ] 4.2 Inject it into both prompts via a new `{{placeholder}}` in `buildReviewStandardPrompt`
      and `buildReviewAdversarialPrompt`, and add the placeholder to `review_standard.md` and
      `review_adversarial.md` (substitution throws on an unfilled placeholder — verified by the
      existing prompt test).

## 5. Regression tests

- [ ] 5.1 `review-policy.test.ts`: a finding with `severity: "high"` (and `critical`) and
      `blocking: false` is classified advisory, never blocking; an otherwise identical finding
      without the marker blocks. Prove the test bites without the partition change.
- [ ] 5.2 `review-policy.test.ts`: a `blocking: false` finding sharing a key with a real blocking
      finding does NOT make that key ambiguous (the override still applies).
- [ ] 5.3 `review-schema.test.ts`: drift guard recognizes `blocking` and fails on a deliberate
      type↔block token mismatch.

## 6. Mirror + gate

- [ ] 6.1 Regenerate the plugin mirror: `node scripts/build.mjs`.
- [ ] 6.2 `npm run ci` green from repo root (core tests + `build.mjs --check` + install smoke).
