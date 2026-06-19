## Why

The adversarial reviewer **never emits LOW findings** — it inflates everything to
MEDIUM because LOW is advisory and so cannot force a fix round. Across 23 adversarial
rounds on 5 recent issues: **0 LOW, ~84% MEDIUM, ~16% HIGH**. The 0-LOW statistic is
direct evidence the severity scale is being gamed by the blocking threshold — defensive
hardening, edge-case nitpicks, and "the next variant of an already-fixed class" get
floored at MEDIUM and block, churning review-2 to the cap.

Two root causes, two fixes:

1. **LOW isn't a real tier.** The shared severity rubric names LOW but gives the model no
   concrete reason or example to use it, so the model rounds up. Re-anchor the rubric so
   the hardening/nitpick/next-variant classes are explicitly LOW, with concrete examples
   and anti-inflation guidance.
2. **There is no non-blocking emission path.** The review prompts tell reviewers *not to
   emit* out-of-scope/pre-existing findings, but the verdict schema has no way to record a
   genuine-but-not-blocking observation — so a reviewer who wants to note something "for
   context" emits it at a blocking severity and it routes to a fix round. Add an explicit
   non-blocking marker (`blocking: false`) to the verdict schema; the review policy treats a
   marked finding as advisory **regardless of severity or confidence**.

These remove the incentive to inflate: a real LOW tier plus an explicit non-blocking channel
give the reviewer an honest place to put observations that should not block.

## What Changes

- **Re-anchor the severity rubric** (single-sourced `SEVERITY_RUBRIC`, injected into both
  review prompts) so LOW is a populated tier: defensive hardening, observability gaps, minor
  inconsistencies, narrow edge-case nitpicks, and "the next variant of a class already fixed
  this round" are explicitly LOW. Add concrete LOW examples and an explicit anti-inflation
  directive ("these are LOW, not MEDIUM").
- **Add a non-blocking marker to the verdict schema.** A new optional `blocking?: boolean`
  field on `ReviewFinding`: absent (or `true`) classifies normally; `false` records the
  finding as a non-blocking observation. The single-sourced schema block
  (`REVIEW_VERDICT_SCHEMA_BLOCK`) gains the field and the drift-guard test recognizes it.
- **Policy treats a marked finding as advisory regardless of severity/confidence.**
  `partitionFindings` moves any finding with `blocking === false` into the advisory set
  before the severity/confidence test, so it never routes to a fix round even at HIGH/CRITICAL,
  and it appears in the all-advisory audit record.
- **Document when to use the marker** in the reviewer prompts: out-of-scope, pre-existing, and
  informational observations — single-sourced and injected into both prompts.

## Acceptance Criteria

- [ ] The shared severity rubric explicitly classifies as **LOW**: defensive hardening,
      observability gaps, minor inconsistencies, narrow edge-case nitpicks, and "the next
      variant of a class already fixed this round."
- [ ] The reviewer prompt gives at least one concrete LOW example and an explicit
      anti-inflation directive so the model actually uses LOW rather than rounding up to MEDIUM.
- [ ] `ReviewFinding` gains an optional `blocking?: boolean` field; `REVIEW_VERDICT_SCHEMA_BLOCK`
      renders the field, and the drift-guard test passes with it present and fails if the field
      is added to the type but not the block (or vice versa).
- [ ] `partitionFindings` classifies any finding with `blocking === false` as advisory
      **regardless of its severity and confidence** — it never appears in the blocking set and
      never routes to a fix round, even at `critical`/`high`.
- [ ] A `blocking: false` finding is excluded from the ambiguity-guard blocking-candidate count
      so it cannot affect whether a same-key blocking finding is overridden.
- [ ] A non-blocking finding is itemized in the all-advisory advance audit comment alongside
      other advisory findings.
- [ ] The reviewer prompts document when to set `blocking: false` (out-of-scope, pre-existing,
      informational), single-sourced and injected into both prompts.
- [ ] Regression tests prove: (a) a finding marked `blocking: false` at `high`/`critical`
      severity is advisory and does not route to a fix round; (b) the drift guard catches a
      type↔schema-block mismatch for the new field; (c) the rubric text contains the LOW classes
      and the anti-inflation directive.

## Impact

- `core/scripts/prompts/index.ts` — `SEVERITY_RUBRIC` re-anchored (LOW classes + examples +
  anti-inflation); new single-sourced "when to mark non-blocking" guidance injected into both
  prompts via a new `{{placeholder}}`.
- `core/scripts/prompts/review_standard.md`, `review_adversarial.md` — carry the new guidance
  placeholder.
- `core/scripts/types.ts` — `ReviewFinding` gains optional `blocking?: boolean`.
- `core/scripts/review-schema.ts` — `REVIEW_VERDICT_SCHEMA_BLOCK` gains the field;
  `FINDING_FIELD_GUARD` / `REVIEW_SCHEMA_FIELDS` updated.
- `core/scripts/review-policy.ts` — `partitionFindings` treats `blocking === false` as advisory
  and excludes such findings from the blocking-candidate fingerprint count.
- `core/scripts/stages/review.ts` — the all-advisory advance comment itemizes non-blocking
  findings (existing advisory-itemization path).
- `core/test/review-schema.test.ts`, `core/test/review-policy.test.ts`, prompt tests — updated
  and new regression coverage.
- `plugin/` — regenerated mirror (`node scripts/build.mjs`).

## Out of Scope

- Changing `block_threshold` / `min_confidence` defaults (tightened in #231).
- Risk-proportional blocking based on the standard review (tracked separately).
- Auto-classification of severity by the engine — the reviewer still self-assigns; this change
  improves the rubric and adds the non-blocking channel only.
- The round-1/round-2 prompt-craft restructuring tracked by the in-flight
  `review-prompt-craft-gaps` change (confidence bands, few-shot, risk-first structure) — this
  change adds only the LOW calibration and the non-blocking channel and does not modify those
  requirements.
