## Why

#389's settled-surface reversal guard matches at the wrong granularity. A "surface" is
`normalize(file) | category` — every finding in the same file and category shares one. The guard
therefore treats *any* otherwise-blocking finding on a file a prior round already fixed as a
reversal, and demotes it to advisory unless the reviewer supplies a `prior_round_acknowledgment`
the reviewer has no reason to supply (it does not know the pipeline classified its finding as a
re-raise).

Observed in #395's run (`395-2026-07-21T07-42-13-786Z`): round-2 finding `b2c42fc0` — "Captured
artifacts are not actually PR-visible", HIGH, confidence 0.99 — was demoted to advisory with reason
`reversal-unacknowledged` and the item advanced to `ready-to-deploy` with no fix and no human
override. Round 1's blocking findings on that file were whitespace-command validation, symlink
containment, and artifact-copy error reporting; none raised PR visibility. The new defect was
silenced solely because it shared a file and category with a settled one.

That is a review-rigor regression: a high-severity, high-confidence, genuinely new finding shipped
silently as advisory, defeating `block_threshold`. Golden rule 3 ("rigor over latency") makes it a
release blocker for the milestone that shipped #389.

## What Changes

- **The reversal guard matches findings, not surfaces.** `partitionFindings` stops consuming a
  `Set<string>` of settled surfaces and instead consumes a list of **settled findings** (key,
  surface, title, settling round) derived from the digest. A new finding is treated as a re-raise
  only when it matches a specific settled finding.
- **A pure, deterministic re-raise matcher** decides that match: same surface *and* (same
  `findingKey`, or a normalized-title similarity at or above a fixed threshold). Surface identity
  alone never suffices.
- **The matcher fails open toward rigor.** When a settled entry's identity is unrecoverable (a
  legacy comment whose title degraded to `(title unavailable)` and whose key does not match), no
  demotion occurs and the finding is partitioned by `review_policy` alone.
- **The audit trail names the matched finding.** The `REVERSAL-UNACKNOWLEDGED` comment tag and the
  `reversal_unacknowledged` event identify *which* prior finding was settled (key + title) and in
  which round, plus how the match was made.
- **The reviewer prompt and the digest wording follow.** They instruct that
  `prior_round_acknowledgment` is required when a finding re-raises a settled **finding**, not when
  it merely touches a previously-fixed file.

No review coverage is removed: this change strictly narrows an over-broad demotion.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `review-cross-round-memory`: the reversal guard's matching granularity, the demotion audit trail,
  and the regression coverage that pins them.

## Acceptance criteria

- [ ] Replaying the #395 history — round 1 blocking findings on `S` (artifact-copy error reporting
      et al.) all `resolved-by-fix`, round 2 raising a distinct HIGH/0.99 finding on `S`
      ("artifacts are not PR-visible") with no `prior_round_acknowledgment` — puts the round-2
      finding in the **blocking** partition.
- [ ] Replaying the same history with a round-2 finding that genuinely re-raises the settled
      finding (same `findingKey`, or same surface and a near-identical title) and no
      `prior_round_acknowledgment` puts it in the **advisory** partition with reason
      `reversal-unacknowledged`.
- [ ] Both regression tests fail against the pre-change `partitionFindings` signature/behavior for
      the first case (proving the test bites).
- [ ] A settled finding at a different line band or severity after a fix, re-raised with an
      unchanged title, is still matched (title similarity), so #389's convergence guarantee is
      preserved.
- [ ] A settled digest entry whose title is `(title unavailable)` and whose key does not match the
      new finding produces no demotion.
- [ ] A demoted finding's `REVERSAL-UNACKNOWLEDGED` tag in the posted review comment names the
      settled finding's key and title and the round that settled it.
- [ ] The `reversal_unacknowledged` event carries the new finding's key, its surface, the settled
      finding's key, the settling round, and the match basis (`key` or `title-similarity`).
- [ ] A finding carrying a non-empty `prior_round_acknowledgment` blocks exactly as it would
      without the guard, and a finding on a `still-open` or absent surface is unaffected — both
      unchanged from #389.
- [ ] The matcher is pure: no filesystem, network, git, or subprocess access, and deterministic for
      a given (finding, digest) pair.
- [ ] `npm run ci` passes, including the regenerated `plugin/` mirror and `openspec validate --all`.

## Impact

- **Code**: `core/scripts/review-history.ts` (replace/augment `settledSurfaces` with a settled-finding
  accessor; add the re-raise matcher); `core/scripts/review-policy.ts` (`partitionFindings`'s guard
  parameter and match call); `core/scripts/stages/review-routing.ts` (wire the new accessor; enrich
  the demotion record and event); `core/scripts/stages/review-rendering.ts` (tag text);
  `core/scripts/run-store.ts` (event shape); `core/scripts/prompts/review_adversarial.md` and the
  digest rendering wording.
- **Tests**: `core/test/review-policy.test.ts`, `core/test/review-history.test.ts`,
  `core/test/pre-merge-autofix.test.ts` (existing guard tests that assume surface-level matching),
  plus the #395 replay regression.
- **Compatibility**: digest derivation, the `blockingFindings` artifact extension, and the
  `prior_round_acknowledgment` schema field are unchanged; no config keys are added.
