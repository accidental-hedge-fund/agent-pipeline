## ADDED Requirements

### Requirement: Both review prompts SHALL define `confidence` bands aligned to `review_policy.min_confidence`

Each review prompt SHALL include a `CONFIDENCE_CALIBRATION_BLOCK` — injected via `{{confidence_calibration}}` — that defines three bands and their policy-linked meaning:

- **High (≥ 0.8):** The reviewer has concrete evidence in the diff. The finding is fully traceable to a specific code path.
- **Medium (0.5–0.8):** The reviewer has a reasonable basis but cannot rule out missing context. The finding is plausible but not certain.
- **Low (< 0.5):** The reviewer is speculating or lacks enough context to be sure. The finding may or may not apply.

A finding whose `confidence` is below the active `review_policy.min_confidence` floor SHALL be treated as advisory, regardless of `severity`. A finding at or above the floor is subject to the `block_threshold` rule. The prompt SHALL state this relationship explicitly so reviewers self-calibrate rather than defaulting to inflated confidence.

#### Scenario: High-confidence finding with evidence

- **WHEN** the reviewer has a specific code path showing a real defect in the diff
- **THEN** the reviewer SHALL set `confidence` ≥ 0.8 and the finding SHALL be evaluated against `block_threshold`

#### Scenario: Low-confidence speculative finding

- **WHEN** the reviewer suspects a problem but cannot point to a specific code path in the diff
- **THEN** the reviewer SHALL set `confidence` < 0.5 and the finding SHALL be advisory regardless of severity

#### Scenario: Confidence below `min_confidence` floor is advisory

- **WHEN** a finding's `confidence` is below the active `review_policy.min_confidence`
- **THEN** the finding SHALL NOT block the issue regardless of its `severity`

### Requirement: `CONFIDENCE_CALIBRATION_BLOCK` SHALL be single-sourced in `index.ts`

The confidence calibration text SHALL be defined as a named constant in `core/scripts/prompts/index.ts` (mirroring `SEVERITY_RUBRIC`) and injected via `{{confidence_calibration}}` into both `buildReviewStandardPrompt` and `buildReviewAdversarialPrompt`. The two prompts SHALL reference the same constant so drift between rounds is structurally prevented.

#### Scenario: Calibration text is identical in both prompts

- **WHEN** both prompts are assembled
- **THEN** the rendered `{{confidence_calibration}}` block SHALL be byte-identical in both, sourced from the shared constant
