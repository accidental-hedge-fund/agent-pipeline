## ADDED Requirements

### Requirement: Each review prompt SHALL include one well-formed finding example and one suppressed-concern example

To anchor the reviewer on both JSON format and the material-only bar, each prompt SHALL embed:

1. **Model finding example** — a finding that meets the material bar: specific code path, real impact, concrete fix suggestion, appropriate severity and confidence.
2. **Suppressed-concern example** — a concern that should NOT be reported: vague, speculative, out-of-diff-scope, or below the material bar, with an explanation of why it is suppressed.

The examples SHALL be tailored to the prompt's round role:
- Standard (round-1) examples reflect broad correctness / convention concerns.
- Adversarial (round-2) examples reflect high-stakes failure modes and attack-surface concerns.

The examples SHALL NOT be sourced from a shared constant — they are intentionally round-specific.

#### Scenario: Reviewer uses the model finding as a format template

- **WHEN** the reviewer encounters a real defect in the diff
- **THEN** the emitted finding JSON SHALL structurally match the example (all required fields present, severity and confidence populated, description and suggestion non-empty)

#### Scenario: Reviewer suppresses a vague concern

- **WHEN** the reviewer has a suspicion that cannot be traced to a specific code path in the diff
- **THEN** the reviewer SHALL NOT emit a finding for it, consistent with the suppressed-concern example shown in the prompt

#### Scenario: Reviewer does not copy the example finding verbatim

- **WHEN** the prompt examples are present
- **THEN** the reviewer SHALL use them as format anchors only, not report the example finding itself as a real finding for the diff under review
