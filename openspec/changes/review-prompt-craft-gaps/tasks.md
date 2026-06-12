## 1. Confidence calibration constant

- [x] 1.1 Add `CONFIDENCE_CALIBRATION_BLOCK` constant to `core/scripts/prompts/index.ts` defining three bands (high ≥ 0.8, medium 0.5–0.8, low < 0.5) and their relationship to `review_policy.min_confidence`.
- [x] 1.2 Add `{{confidence_calibration}}` placeholder injection to `buildReviewStandardPrompt` and `buildReviewAdversarialPrompt` in `index.ts`.
- [x] 1.3 Insert `{{confidence_calibration}}` into `review_standard.md` and `review_adversarial.md` after the severity rubric block.

## 2. Few-shot examples

- [x] 2.1 Add one well-formed finding example and one suppressed-concern example to `review_standard.md`, tailored to the standard reviewer's broad first-pass stance.
- [x] 2.2 Add one well-formed finding example and one suppressed-concern example to `review_adversarial.md`, tailored to the adversarial reviewer's skeptical/attack-surface stance.

## 3. Diff-scoping and false-positive cost framing

- [x] 3.1 Add diff-scoping instruction to `review_standard.md`: scope findings to the changed code and its blast radius; pre-existing code outside the diff is out of scope.
- [x] 3.2 Add diff-scoping instruction to `review_adversarial.md` with the same language.
- [x] 3.3 Add false-positive cost framing to both prompts: a wrong finding costs a full fix cycle; when uncertain, lower `confidence` to the advisory band or omit the finding.

## 4. Risk-first structure for the standard prompt

- [x] 4.1 Restructure `review_standard.md` so the reviewer first states an overall risk tier (high / medium / low) with one-line rationale before listing findings.
- [x] 4.2 Demote the existing flat checklist to a "reference dimensions" section beneath the risk assessment, framed as: cover all high-risk dimensions exhaustively; cover low-risk dimensions briefly.

## 5. Strip deterministic asks from the standard prompt

- [x] 5.1 Remove the "Acceptance criteria met?" and "CI expectations?" lines from `review_standard.md` (lines 20–21 on `origin/main`).

## 6. Repo-tailored adversarial attack surface

- [x] 6.1 Replace the fixed enterprise-flavored attack-surface list in `review_adversarial.md` with a two-tier structure: (a) core-always tier (data loss, auth/trust, rollback safety, ordering, null/timeout, version skew); (b) repo-tailored instruction to derive additional attack surfaces from `{{conventions}}` and the diff itself, not a fixed catalogue.

## 7. Round-1 / round-2 differentiation

- [x] 7.1 Add a de-duplication instruction to the adversarial prompt's "Operating Stance": do not re-raise findings already present in `{{review1_section}}` or `{{prior_review2_findings}}` unless new evidence materially elevates the assessment.
- [x] 7.2 Add a round-role summary line at the top of each prompt: standard = "broad risk survey, first pass"; adversarial = "targeted deep-dive on high-risk vectors not yet resolved".

## 8. Tests and mirror sync

- [x] 8.1 Verify `review-schema.test.ts` drift-guard passes unchanged (schema shape is unchanged).
- [x] 8.2 Run `node scripts/build.mjs` to regenerate `plugin/` mirror.
- [x] 8.3 Run `npm run ci` from repo root; all checks green.
- [ ] 8.4 Spot-check both prompts against a real past diff to confirm equal-or-better findings with fewer false positives compared to the pre-change prompts.
