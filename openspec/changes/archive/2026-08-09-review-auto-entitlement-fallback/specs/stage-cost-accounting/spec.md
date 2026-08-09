## ADDED Requirements

### Requirement: Reviewer auto entitlement attempts SHALL record requested, resolved, and fallback provenance

When a reviewer stage performs an auto-sourced preferred-model attempt and an allowlisted entitlement fallback attempt, each attempt’s stage accounting record SHALL populate the existing optional provenance fields: `requested_model` (the model requested for that attempt), `resolved_model` when the harness reports a served model, and `fallback` set to `true` on the allowlisted fallback attempt (and may also be set on a summary record that indicates fallback occurred). Zero-token entitlement failures SHALL still emit an accounting record with outcome reflecting failure and `throttled` when the harness reports throttle, without inventing non-zero token counts.

#### Scenario: Preferred auto attempt and sonnet retry are both accounted

- **WHEN** plan-review or design-gate auto-sources `claude-fable-5`, that attempt fails entitlement with zero tokens, and the allowlisted `sonnet` retry runs
- **THEN** accounting SHALL include a record for the `claude-fable-5` attempt with `requested_model` equal to `claude-fable-5`
- **AND** accounting SHALL include a record for the `sonnet` attempt with `requested_model` equal to `sonnet`
- **AND** the fallback attempt record SHALL set `fallback` to `true`

#### Scenario: Zero-token entitlement failure does not invent usage

- **WHEN** the preferred auto attempt fails with provider-reported zero tokens
- **THEN** the accounting usage counters SHALL be zero only if the provider reported zero, otherwise omitted/null per existing usage rules
- **AND** the record SHALL still carry model request provenance for the failed attempt
