## ADDED Requirements

### Requirement: Harness entitlement and ordinary throttle SHALL project to typed durable classes

When a durable-run item blocks because a harness invoke failed with **ordinary transient rate limiting / throttling**, the stage diagnostic projection SHALL resolve to `transient-rate-limit` (for example via the existing `transient-infra` reason code). When a durable-run item blocks because a harness invoke failed with a **model entitlement / usage-credit refusal** (including the Fable-requires-usage-credits class after auto fallback is exhausted or when the model was explicit), the projection SHALL resolve to `environment-auth` via a distinct canonical reason code (`model-entitlement-required` or `capability-refusal`) so metrics can separate account entitlement from credential auth failures. Neither ordinary throttle nor entitlement refusal SHALL project to `workflow-engine-defect` solely because the harness reported zero input/output tokens, a short duration, `throttled: true` on accounting, or non-JSON / non-verdict stdout that is the entitlement message itself.

Unknown diagnostics that match no known reason code SHALL continue to fail closed as `workflow-engine-defect` per the existing unknown-blocker requirement; this requirement only constrains the two known harness failure classes above.

#### Scenario: Ordinary throttle projects to transient-rate-limit

- **WHEN** a stage diagnostic carries ordinary rate-limit / throttle evidence without entitlement-specific usage-credit text
- **THEN** projection SHALL yield blocker class `transient-rate-limit`
- **AND** it SHALL NOT yield `workflow-engine-defect` for that diagnostic

#### Scenario: Entitlement refusal projects to environment-auth

- **WHEN** a stage diagnostic carries Fable/usage-credit entitlement refusal after auto fallback exhaustion or for an explicit model
- **THEN** projection SHALL yield blocker class `environment-auth`
- **AND** the reason code SHALL be distinct from a generic missing credential when the failure is entitlement/capability
- **AND** it SHALL NOT yield `workflow-engine-defect` for that diagnostic

#### Scenario: Zero-token entitlement message is not an unmatched engine defect by default

- **WHEN** a reviewer harness returns the usage-credit entitlement text with zero tokens and the diagnostic is emitted with the entitlement reason code
- **THEN** durable classification SHALL follow the entitlement projection above
- **AND** recovery policy selection SHALL use the `environment-auth` budget and recipes, not the `workflow-engine-defect` budget
