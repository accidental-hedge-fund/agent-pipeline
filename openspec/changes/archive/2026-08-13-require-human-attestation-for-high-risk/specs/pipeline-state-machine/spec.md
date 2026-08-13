## ADDED Requirements

### Requirement: STAGES SHALL include pre-code-attestation between plan-review and implementing

The ordered `STAGES` constant SHALL include `pre-code-attestation` after `plan-review` and before
`implementing`. The stage is always present in the graph but is **inert unless**
`cfg.pre_code_attestation.enabled` is true and a risk trigger matches. When disabled or untriggered,
the stage SHALL advance immediately toward `implementing` with a recorded reason and without a human
attestation hold. Gate behavior is specified by the `pre-code-attestation` and
`pre-code-design-dossier` capabilities. This stage SHALL NOT replace `plan-review` or `design-gate`,
and SHALL NOT introduce additional mandatory Product, Architecture, Program Design, or Vertical
Slice stages.

#### Scenario: STAGES order includes pre-code-attestation

- **WHEN** the `STAGES` constant is inspected
- **THEN** `pre-code-attestation` SHALL appear at an index greater than `plan-review` and less than `implementing`
- **AND** `design-gate` SHALL remain between `implementing` and `review-1`

#### Scenario: dispatch routes pre-code-attestation

- **WHEN** the current stage label is `pipeline:pre-code-attestation`
- **THEN** the orchestrator SHALL call the pre-code attestation stage handler
- **AND** SHALL NOT call the implementing handler in the same transition until the stage advances

#### Scenario: disabled gate is a no-op pass-through

- **WHEN** the current stage is `pre-code-attestation` and `cfg.pre_code_attestation.enabled` is `false`
- **THEN** the issue SHALL transition toward `implementing` in the same run
- **AND** no human attestation SHALL be required by this stage

#### Scenario: untriggered enabled gate is a no-op pass-through

- **WHEN** the current stage is `pre-code-attestation`, the gate is enabled, and no risk trigger matches
- **THEN** the issue SHALL transition toward `implementing` in the same run
- **AND** the stage record SHALL carry reason `no-trigger-matched`
)
