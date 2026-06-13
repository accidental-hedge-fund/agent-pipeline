## Why

`review_standard.md` and `review_adversarial.md` are the actual review gate for every pipeline run (`reviewMode: prompt-harness` is the only supported backend since #54), yet six prompt-craft gaps remain that cause calibration noise, false-positive blocking, and redundant round-1/round-2 overlap. The severity rubric and enumerate-every-instance instruction shipped in #110/#111; these are the remaining items identified in the 2026-06-10 maintainer simplification audit.

## What Changes

- **Confidence calibration** — add band definitions (high/medium/low) to both prompts, explicitly tied to `review_policy.min_confidence` (#86) so the `confidence` field carries consistent meaning run-to-run.
- **Few-shot examples** — add one well-formed finding example and one suppressed-concern example to each prompt, anchoring both JSON format and the material-only bar.
- **Diff-scoping and false-positive cost framing** — add explicit instruction in both prompts to scope review to the diff and its blast radius (not pre-existing code), and to lower `confidence` or omit a finding when uncertain rather than emitting a blocking finding the implementer must refute.
- **Risk-first structure for the standard prompt** — restructure `review_standard.md` so the reviewer first assesses the change's overall risk profile and allocates review depth proportionally, rather than walking a flat checklist.
- **Strip deterministic asks from the standard prompt** — remove lines 20–21 of `review_standard.md` ("Acceptance criteria met?" and "CI expectations?"); CI already proves these pass/fail; keeping them wastes reviewer judgment on questions with deterministic answers.
- **Repo-tailored attack surface for the adversarial prompt** — replace the fixed enterprise-flavored list (tenant isolation, PHI) with an instruction to select the relevant subset for the repo type, derived from the repo's conventions and `{{conventions}}` context.
- **Round-1 / round-2 differentiation** — make the standard prompt a broad, first-pass risk survey and the adversarial prompt a targeted deep-dive that explicitly avoids re-raising findings already dispositioned in `{{prior_review2_findings}}` and `{{review1_section}}`.

## Capabilities

### New Capabilities
- `review-prompt-confidence-calibration`: Both review prompts define `confidence` bands and their alignment to `min_confidence` in the active `review_policy`.
- `review-prompt-few-shot-anchoring`: Both review prompts include one well-formed positive example and one suppressed-concern example.

### Modified Capabilities
- `review-layer`: The standard review prompt gains risk-first structure, drops deterministic-ask checklist items, adds diff-scoping and false-positive cost framing; the adversarial prompt gains repo-tailored attack surface selection and tighter round-2 differentiation. No schema fields change.

## Impact

- `core/scripts/prompts/review_standard.md` — restructured; two checklist lines removed.
- `core/scripts/prompts/review_adversarial.md` — attack-surface instruction updated; round-2 differentiation added.
- `core/scripts/prompts/index.ts` — if confidence calibration text or few-shot examples are best single-sourced as constants (like `SEVERITY_RUBRIC`), new constants are added there and injected via new `{{placeholders}}`.
- No changes to `review-schema.ts`, the state-machine edges, or any other stage.
- `core/test/review-schema.test.ts` drift-guard test must remain green (schema shape unchanged).
