## 1. Structured direction signal (emit + read, drift-guarded)

- [x] 1.1 Add a `SpecDivergenceDirection` token set (`code-behind-spec` | `spec-behind-code`) and a single-sourced `directionMarker(direction)` next to `categoryMarker`/`SPEC_DIVERGENCE_CATEGORY` in `review-policy.ts`; add a reader that extracts the direction of a `spec-divergence` finding from a rendered review body (exact-marker match, never prose).
- [x] 1.2 Render the direction marker per `spec-divergence` finding in `formatReviewComment` (review.ts), single-sourced so emit + read cannot drift.
- [x] 1.3 Extend the reviewer prompts (`review_standard.md`, `review_adversarial.md`) + `prompts/index.ts` / `review-schema.ts` so a `spec-divergence` finding is emitted with its direction; keep the JSON schema block and the drift-guard test in sync.

## 2. Disambiguate + post-fix evaluation in the guard

- [x] 2.1 In `openspec-consistency.ts`, classify the current-state divergence direction from the structured marker; record it on the returned `Outcome`.
- [x] 2.2 Base the stale-delta decision on the current post-fix head, not a pre-fix marker: only treat a divergence as unresolved when its signal corresponds to the current head (verdict `commitSha` matches HEAD or the divergence reproduces against it).
- [x] 2.3 Narrow the block condition: require positive `spec-behind-code` evidence before treating the delta as stale. `code-behind-spec` or unclassified → do not force spec repair, do not block on file-order alone (fixes #849).

## 3. Bounded, code-frozen, validated automatic spec repair

- [x] 3.1 Add a bounded repair orchestrator (injectable deps: harness invoker, `gitDiffFiles`, `openspecValidateItem`, committer, `setBlocked`) that runs at most once per run and only on `spec-behind-code` evidence that is verifiable without changing application code.
- [x] 3.2 Enforce the allow-list: reject/roll back any attempt that changes a file outside `openspec/changes/<id>/specs/**` or that change's `tasks.md`; never commit a disallowed diff.
- [x] 3.3 Run `openspec validate <id>` on the repair; commit a valid repair with the run's `Issue:`/`Pipeline-Run:` traceability trailers; re-run the stale-delta guard exactly once against the post-repair state.

## 4. Direction-specific blocking

- [x] 4.1 Produce a direction-specific block reason: *code alignment* (implementation still diverges from the active spec) vs *spec-delta alignment* (delta stale, repair did not converge). Keep `blockerKind: "openspec-stale-delta"` for the spec-delta case (no new enum value, no recovery-recipe snapshot change).

## 5. Wire into stage call sites

- [x] 5.1 `stages/fix.ts` (`enforceFixOpenspecConsistency`) and `stages/pre_merge.ts` (`maybeArchiveOpenspec`) invoke the disambiguated guard + bounded repair through injectable deps; the guard still runs at both sites; a `spec-behind-code` state that does not converge blocks before `openspec archive`.

## 6. Tests (each must bite without the fix)

- [x] 6.1 Direction marker: emit + read round-trip; unclassified body yields no direction; prose-only mention yields no direction (drift-guard).
- [x] 6.2 Post-fix evaluation: pre-fix marker resolved by a later fix → not stale; divergence corresponding to post-fix head → unresolved.
- [x] 6.3 Regression (#849 shape): active delta already requires the behavior, review flags implementation `code-behind-spec`, fix changes implementation only → guard does NOT post `openspec-stale-delta`, run advances.
- [x] 6.4 Regression (true stale-delta shape): current state `spec-behind-code`; verified code-frozen repair succeeds and clears the guard; and a variant where repair cannot be verified without code changes → not archived, blocks with a spec-delta-alignment reason.
- [x] 6.5 Bounded repair: disallowed-file attempt rejected (not committed); invalid OpenSpec → block; repair bounded to one attempt; guard re-run exactly once.
- [x] 6.6 Block reasons: `code-behind-spec` non-convergence → code-alignment reason; still-stale after repair → spec-delta-alignment reason.

## 7. Mirror + CI

- [x] 7.1 `node scripts/build.mjs` to regenerate the `plugin/` mirror; commit it in the same change.
- [x] 7.2 `npm run ci` green from repo root (core tests, mirror check, install smoke, `openspec validate --all`).
