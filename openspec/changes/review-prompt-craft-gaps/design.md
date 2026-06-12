## Context

Both review prompts are Markdown templates in `core/scripts/prompts/` assembled by builder functions in `index.ts`. Constants like `SEVERITY_RUBRIC` are single-sourced there and injected via `{{placeholders}}`; the verdict JSON schema is injected via `{{schema_block}}` (single-sourced in `review-schema.ts`). The drift-guard test (`review-schema.test.ts`) catches schema/prompt divergence. This change is purely a prompt-craft improvement — no state-machine edges, no schema fields, and no stage logic change.

## Goals / Non-Goals

**Goals**
- Make `confidence` a meaningful signal: calibrated bands + alignment to `min_confidence` so the reviewer knows when a finding is advisory vs. blocking before it routes.
- Anchor format and material bar via few-shot examples embedded in each prompt.
- Eliminate out-of-scope false blocks via explicit diff-scoping and false-positive cost framing.
- Make standard (round-1) and adversarial (round-2) prompts genuinely complementary rather than overlapping.
- Remove the two checklist items CI already answers deterministically.
- Fit the attack surface list to the actual repo type instead of mandating a full enterprise catalogue.

**Non-Goals**
- Schema field changes (blocked by the drift-guard test; out of scope per issue).
- Changing review modes or adding new reviewer backends.
- Adding new pipeline stages or state-machine edges.
- Semantic or test-coverage evaluation (CI handles this).

## Decisions

**Decision: confidence calibration as a single-sourced constant (like SEVERITY_RUBRIC).**
Add a `CONFIDENCE_CALIBRATION_BLOCK` constant to `index.ts` injected via `{{confidence_calibration}}` in both prompts. This mirrors the existing `SEVERITY_RUBRIC` pattern and keeps the calibration text drift-guarded. Alternative (inline in each prompt) risks divergence between rounds. The block must explicitly name the three bands and tie them to `review_policy.min_confidence`: a `confidence` below the policy floor makes the finding advisory; above it makes the finding blockable at the active `block_threshold`.

**Decision: few-shot examples are inline in each prompt, not single-sourced.**
The standard and adversarial rounds have different material bars, so their examples should be tailored. A shared constant would force the examples to be generic and less anchoring than purpose-fit ones. Each prompt gets one "model finding" and one "suppressed concern" that match the prompt's own stance and severity bar.

**Decision: risk-first preamble replaces the flat checklist in the standard prompt.**
The flat checklist (`Correctness`, `Tests`, `Repo conventions`, …) is retained but demoted to a secondary reference. The reviewer is first instructed to assess the change's overall risk tier (high / medium / low), then allocate review depth proportionally. Low-risk cosmetic changes get a lighter pass; high-risk data-path changes get exhaustive coverage. This prevents a 2-line typo fix from consuming the same review budget as a schema migration.

**Decision: `review_standard.md:20-21` removed (the two deterministic-ask checklist items).**
The lines "Acceptance criteria met?" and "CI expectations?" are answered by CI green/red — they add no reviewer judgment value and can produce false positive findings when CI state isn't visible to the reviewer at prompt time. Removing them is pure de-noise, consistent with the 2026-06-10 maintainer audit decision.

**Decision: adversarial attack-surface list becomes a tiered-selection instruction.**
Replace the flat list with: (1) a short core-always-apply tier (data loss, auth/trust, rollback safety, ordering, null/timeout, version skew), and (2) an instruction to pull additional attack surfaces from `{{conventions}}` and the change diff rather than mandating PHI / tenant-isolation checks on every repo.

**Decision: round-2 differentiation via explicit de-duplication instruction.**
The adversarial prompt already receives `{{prior_review2_findings}}` and `{{review1_section}}`. Extend the "Operating Stance" to explicitly instruct the adversarial reviewer NOT to re-raise findings already present in those sections unless new evidence elevates them. This cuts overlap without collapsing the two rounds into one; the adversarial prompt retains its skeptical stance and attack-surface focus, it just spends budget on new vectors rather than re-litigating round-1 findings.

## Risks / Trade-offs

- *Confidence calibration bands are inherently subjective* — the bands anchor on the `min_confidence` policy value, not a fixed threshold. If the policy changes, prompt guidance stays correct because it references the policy concept, not a hardcoded number.
- *Few-shot examples can anchor too narrowly* — mitigated by choosing examples that are clearly at the boundary of "report this" vs. "suppress this" so they calibrate the bar without over-constraining the reviewer to that exact finding shape.
- *De-duplication instruction may suppress a legitimately escalated finding* — instruction says "unless new evidence elevates them," giving the adversarial reviewer room to re-raise when they have a stronger argument.
