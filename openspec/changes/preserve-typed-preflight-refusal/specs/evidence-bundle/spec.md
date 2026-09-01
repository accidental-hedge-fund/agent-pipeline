## ADDED Requirements

### Requirement: Durable evidence SHALL record typed production-preflight refusal without prompt or secrets

The evidence bundle SHALL record `preflight_failed`, `preflight_class`, `preflight_reason_code`, intervention kind, and the bounded actionable message when a mutating implementer stage blocks on a typed production-preflight refusal. The evidence SHALL NOT include prompt content, argv, credentials, or other secrets. Existing secret-redaction rules SHALL apply to any residual diagnostic text.

#### Scenario: Typed fields appear in durable evidence

- **WHEN** `fix-1` or another mutating stage blocks on `preflight_failed: true` with `preflight_reason_code: capability-refusal`
- **THEN** the evidence bundle or stage diagnostic record SHALL include `preflight_failed`, `preflight_class`, `preflight_reason_code`, and intervention kind
- **AND** SHALL include the bounded actionable message

#### Scenario: Prompt and secrets stay out of the refusal record

- **WHEN** the refused invocation had a materialized prompt and the adapter diagnostic contains credential-shaped text
- **THEN** the durable refusal record SHALL NOT contain the prompt body
- **AND** SHALL NOT contain raw credentials
- **AND** residual diagnostic text SHALL be sanitized and bounded
