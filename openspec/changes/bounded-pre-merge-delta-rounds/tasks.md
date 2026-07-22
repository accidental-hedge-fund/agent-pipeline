## 1. Configuration

- [ ] 1.1 Add `max_delta_rounds: number` to the `review_policy` block in `core/scripts/types.ts` with a comment explaining the delta-round budget and its independence from `max_adversarial_rounds`.
- [ ] 1.2 Set `DEFAULT_CONFIG.review_policy.max_delta_rounds = 4` and wire the resolution fallback in `core/scripts/config.ts`.
- [ ] 1.3 Add the zod schema entry (`z.number().int().positive().optional()`) with a description, add `review_policy.max_delta_rounds` to the config key allowlist, and render it as a documented optional key in scaffolded config output.
- [ ] 1.4 Tests: default applies when absent, explicit value honored, `0`/negative/non-integer rejected, key present in allowlist and schema output, misspelling reported as unknown key.

## 2. Digest: confidence and rejected alternatives

- [ ] 2.1 Add optional `rejected_alternatives: string[]` to `ReviewFinding` in `core/scripts/types.ts`.
- [ ] 2.2 Add `rejected_alternatives` to `REVIEW_VERDICT_SCHEMA_BLOCK`, the finding field guard, and `REVIEW_SCHEMA_FIELDS` in `core/scripts/review-schema.ts` so the existing drift guard covers it; update the drift-guard test.
- [ ] 2.3 Instruct in `core/scripts/prompts/review_adversarial.md` that a recommendation requiring removal/replacement of an existing design MUST name the ruled-out alternative in `rejected_alternatives`; add the drift-guarding assertion in `prompt-loader.test.ts`.
- [ ] 2.4 Extend the `blockingFindings` review-artifact extension (`stages/review-rendering.ts` builder, `stages/review-parsing.ts` type + `isValidBlockingFindings` structural validator) with optional `confidence` and `rejectedAlternatives`; reject structurally invalid values rather than trusting them.
- [ ] 2.5 Add `confidence?: number` and `rejectedAlternatives: string[]` to `DigestEntry` in `core/scripts/review-history.ts`; populate from the artifact rung and default to absent/empty on the marker fallback rungs.
- [ ] 2.6 Tests: artifact rung carries both values through to entries; marker rungs still yield entries with no confidence and empty alternatives and do not throw.

## 3. Settled-alternative reinstatement guard

- [ ] 3.1 Add `rejectedAlternatives` to `SettledFinding` and carry it through `settledFindings()`.
- [ ] 3.2 Implement `matchSettledAlternative(finding, settled)` in `review-history.ts` reusing the existing normalized-token similarity machinery (stopwords, suffix stripping) with an exported threshold constant; require non-null `surfaceKey` equal to the settled entry's surface; never match an entry with an empty alternatives list; pure, no I/O.
- [ ] 3.3 Add the `settled-alternative-reinstated` advisory reason to `partitionFindings` in `core/scripts/review-policy.ts`, evaluated independently of the `reversal-unacknowledged` guard, with an audit detail carrying the settled key, settling round, and matched alternative.
- [ ] 3.4 Render the `SETTLED-ALTERNATIVE-REINSTATED` tag in review and delta-review comments (`stages/review-rendering.ts`) naming the settled key, matched alternative, and settling round — never silently drop the finding.
- [ ] 3.5 Emit one `settled_alternative_reinstated` event per demotion from the review and pre-merge delta paths.
- [ ] 3.6 Tests: new-key/re-framed reinstatement demoted; acknowledged reinstatement blocks; different surface not matched; empty alternatives never match; partition output unchanged with no settled alternatives; matcher purity.

## 4. Override-settled trade-offs in the digest

- [ ] 4.1 Render `overridden` entries as settled constraints of the same standing as `resolved-by-fix`, including the override rationale and any rejected alternatives.
- [ ] 4.2 Extend the digest preamble to state that an operator override settles a trade-off as bindingly as a fix, and that re-raising one as blocking — including under a re-framed axis or new key — requires `prior_round_acknowledgment`.
- [ ] 4.3 Tests: override entry rendering; drift-guarding assertion on the preamble text.

## 5. Confidence-trend churn detector

- [ ] 5.1 Implement `detectSuspectedChurn(blockingFindings, digest)` in `review-history.ts` returning the involved axes with prior maximum and new confidences, or none; require all-settled axes, all confidences present, and strictly declining confidence; pure, no I/O.
- [ ] 5.2 Tests: declining-on-settled reports churn; unsettled axis suppresses; non-declining suppresses; missing confidence suppresses; purity.

## 6. Durable delta-round counting

- [ ] 6.1 Implement a pure `countDeltaRounds(comments, { actor, trustedOverrideActors })` (counting bodies starting with `DELTA_REVIEW_MARKER_PREFIX` from trusted authors) alongside the digest derivation in `review-history.ts`; no run-local state, no I/O.
- [ ] 6.2 Tests: counts trusted delta comments only; ignores untrusted authors and non-delta bodies; purity.

## 7. Pre-merge delta ceiling

- [ ] 7.1 In `enforceReviewShaGate` (`core/scripts/stages/pre_merge.ts`), compute the delta-round count from the already-fetched issue comments before invoking the delta-review seam.
- [ ] 7.2 When the count is at or above `max_delta_rounds`, skip the reviewer invocation and apply `ceiling_action` — reusing the review-2 ceiling disposition helpers so `park`, `demote_and_advance` (below-high demotion + single tracked follow-up issue), and the high/critical hard-park override behave identically.
- [ ] 7.3 Post a ceiling comment naming the observed count, the cap, and the applied action.
- [ ] 7.4 Emit one `delta_round` event per delta round (round number + cap) and one `delta_round_ceiling` event at the ceiling (observed, cap, action).
- [ ] 7.5 Wire `detectSuspectedChurn` into the delta path: label the posted comment and emit exactly one `delta_churn_suspected` event, without altering the blocking partition.
- [ ] 7.6 Tests (fake seams, no network/git/subprocess): at the cap the reviewer seam is never invoked; park routes to `needs-human` with the punch list; `demote_and_advance` demotes below-high and proceeds; high/critical hard-parks under both actions; below the cap the existing path is unchanged; delta rounds never touch the `max_adversarial_rounds` counter and vice versa; churn flag does not change the blocking set.

## 8. Observability records

- [ ] 8.1 Register the four new event types in the run event schema/type union.
- [ ] 8.2 Record the delta-round accounting (count, cap, ceiling disposition, churn flags) in the evidence bundle and render it in the human-readable summary; keep writes non-fatal.
- [ ] 8.3 Tests: events appended with the specified fields and streamed under `--json-events`; `summary.json` records the accounting; valid without the record when no delta rounds ran; write failure is non-fatal.

## 9. Regression replay and gate

- [ ] 9.1 Add the fuseiq-core#95 five-round replay fixture (rounds 1–4 genuine, round 5 new keys + re-worded titles + declining confidence + recommendation reinstating the round-2 rejected alternative) with fake comments only.
- [ ] 9.2 Assert the fifth round is never reviewed under the default cap, and that round-5 findings partitioned against the settled entries land advisory. Prove each test bites by confirming it fails without the corresponding fix.
- [ ] 9.3 Regenerate the mirror (`node scripts/build.mjs`) and commit `plugin/` in the same change.
- [ ] 9.4 Run `npm run ci` from the repo root and confirm it is green, including `openspec validate --all`.
