## ADDED Requirements

### Requirement: Typed-request handoffs SHALL carry the classifier payload

A handoff created for a `DecisionRequest` SHALL include recommendation, rationale, alternatives, risk, and evidence. A handoff created for a `CapabilityRequest` SHALL include the missing capability or information, provider, live probe, and resume condition. A handoff created for an `AuthorityRequest` SHALL include eligible actor, repository, operation, scope, candidate epoch, evidence, and expiry, and SHALL NOT record a default grant. Pipeline SHALL still use `pipeline handoff answer` as the answer surface. Pipeline SHALL NOT add a second answer ledger or a new handoff CLI verb.

#### Scenario: DecisionRequest handoff carries the package

- **WHEN** create runs for an irreducible `DecisionRequest`
- **THEN** the pending handoff SHALL include recommendation, rationale, alternatives, risk, and evidence
- **AND** `authority_mode` SHALL follow existing product-judgment rules without converting the request into an authority grant

#### Scenario: CapabilityRequest handoff names the probe

- **WHEN** create runs for an input-requiring `CapabilityRequest`
- **THEN** the pending handoff SHALL include provider, live probe, and resume condition
- **AND** `authority_mode` SHALL be `non_authority`

#### Scenario: AuthorityRequest handoff never defaults

- **WHEN** create runs for a protected `AuthorityRequest`
- **THEN** the pending handoff SHALL bind eligible actor, repository, operation, scope, candidate epoch, evidence, and expiry
- **AND** SHALL NOT store a default grant

---

### Requirement: Candidate movement SHALL invalidate candidate-bound handoffs and grants

When a handoff or grant is bound to a candidate SHA or candidate epoch and that candidate moves, resume validation SHALL refuse the stale record. Pipeline SHALL re-run the shared classifier against current facts. This requirement SHALL NOT weaken the existing reviewed-SHA gate for mid-flight human-decision-required evidence.

#### Scenario: Moved candidate refuses resume

- **WHEN** an answered handoff is bound to candidate SHA A
- **AND** the current candidate is SHA B
- **THEN** resume validation SHALL fail
- **AND** the item SHALL NOT advance on that answer

#### Scenario: Grant bound to old epoch is invalid

- **WHEN** an authority grant is bound to candidate epoch E1
- **AND** the current epoch is E2
- **THEN** that grant SHALL NOT authorize the bound operation
- **AND** a leftover blocked label SHALL NOT restore the grant
