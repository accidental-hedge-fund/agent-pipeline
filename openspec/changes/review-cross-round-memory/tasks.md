## 1. Structured round evidence

- [x] 1.1 Add optional `blockingFindings?: Array<{ key: string; surface: string | null; severity: string; title: string }>` to the `ReviewArtifact` type in `core/scripts/stages/review-parsing.ts`, keeping `extractReviewArtifact` tolerant of its absence
- [x] 1.2 Populate `blockingFindings` in `formatReviewComment` (and `formatDeltaReviewComment`) from the blocking partition, using `findingKey` / `surfaceKey` and truncating `title` to 120 chars
- [x] 1.3 Test: artifact round-trips `blockingFindings`; an artifact without the field still decodes; existing gates that read `reviewedSha` / `blockingKeys` are unaffected

## 2. Digest derivation (pure)

- [x] 2.1 Create `core/scripts/review-history.ts` with `PriorRoundDigest` / `DigestEntry` types and `buildPriorRoundDigest(comments, opts)` — pure, no I/O
- [x] 2.2 Implement the per-comment fallback ladder: `blockingFindings` → `pipeline-blocking-surfaces` → `pipeline-blocking-keys` / `artifact.blockingKeys` → no entries; never infer from prose
- [x] 2.3 Apply the trust boundary: review comments from the pipeline actor only; override comments via `buildTrustedOverrideComments` with `trusted_override_actors`
- [x] 2.4 Derive `resolution` (`overridden` → `resolved-by-fix` → `still-open`) and carry override reason + recording round; exclude advisory findings
- [x] 2.5 Expose `settledSurfaces(digest): Set<string>` for surfaces whose latest resolution is `resolved-by-fix` or `overridden`
- [x] 2.6 Tests: each ladder rung, each resolution branch, untrusted-comment exclusion, advisory exclusion, and a no-I/O assertion

## 3. Digest rendering

- [x] 3.1 Implement `renderPriorRoundDigest(digest)` emitting round/SHA headers and one line per entry (key, surface, severity, title, resolution, override reason)
- [x] 3.2 Enforce caps: 12 entries/round, 8 rounds, 4 000 chars total, oldest-first truncation with a `[… N earlier entries truncated]` marker; titles at 120 chars
- [x] 3.3 Render `(title unavailable)` for entries recovered without a title
- [x] 3.4 Pass the section through `sanitizeBriefForPrompt` and wrap it in `<untrusted-external-evidence>` with the no-instructions directive; return `""` for an empty digest
- [x] 3.5 Tests: caps and truncation marker, no bodies/recommendations/diffs in output, redaction of injection imperatives, fence present/absent

## 4. Prompt injection

- [x] 4.1 Add the `{{prior_rounds_digest}}` placeholder to `core/scripts/prompts/review_adversarial.md` with the settled-constraint framing and the "third option, not a reversal" instruction
- [x] 4.2 Substitute it in `buildReviewAdversarialPrompt` and `buildDeltaReviewPrompt` (empty string when no prior rounds); leave `review_standard.md` untouched
- [x] 4.3 Test: byte-identical rendering vs. a pre-change golden when the digest is empty; digest present for round 2 and for the delta review; no placeholder in `review_standard.md` (drift guard in `prompt-loader.test.ts`)

## 5. Reversal guard

- [x] 5.1 Add optional `prior_round_acknowledgment` to `ReviewFinding` in `core/scripts/types.ts`
- [x] 5.2 Add the field to `REVIEW_VERDICT_SCHEMA_BLOCK`, `FINDING_FIELD_GUARD`, and `REVIEW_SCHEMA_FIELDS`; confirm the drift guard in `review-schema.test.ts` bites before the update
- [x] 5.3 Document the field's requirement in the adversarial prompt's digest section
- [x] 5.4 Extend `partitionFindings` with an optional settled-surface set: demote an otherwise-blocking finding on a settled surface with an absent/blank acknowledgment into advisory with reason `reversal-unacknowledged`
- [x] 5.5 Tests: demoted without acknowledgment, blocks with acknowledgment, unsettled surface unaffected, and partition output unchanged when no digest is supplied

## 6. Surfacing the demotion

- [x] 6.1 Render the `REVERSAL-UNACKNOWLEDGED` tag (naming the settling round) for demoted findings in `formatReviewComment`
- [x] 6.2 Emit one event per demotion carrying finding key, surface, and settling round
- [x] 6.3 Tests: comment tag present and finding not dropped; exactly one event per demotion

## 7. Wiring

- [x] 7.1 Build the digest in `core/scripts/stages/review.ts` from the already-fetched trusted comments and pass it to the prompt builder and to `partitionFindings`
- [x] 7.2 Do the same in the pre-merge delta review path in `core/scripts/stages/pre_merge.ts`
- [x] 7.3 Verify the review-SHA gate, ceiling, recurrence, and early-park guards are untouched

## 8. Regression replays

- [x] 8.1 Add the castrecall-#5-style cap-reversal fixture history and assert settled constraints in the round-3 prompt plus demotion of the unacknowledged reversal
- [x] 8.2 Add the castrecall-#61-style 401/403 reversal fixture history with the same assertions
- [x] 8.3 Confirm both tests fail without the change

## 9. Close out

- [x] 9.1 Run `node scripts/build.mjs` and commit the regenerated `plugin/` mirror
- [x] 9.2 Run `npm run ci` from the repo root and confirm green, including `openspec validate --all`
