## ADDED Requirements

### Requirement: Grill decision resolution SHALL record the recommendation package

Grill SHALL write every newly settled or requested decision node with recommendation, rationale, alternatives, risk, and evidence. Grill SHALL use the shared typed-request-resolution classifier rather than a grill-only predicate copy. A newly written resolution that omits the package SHALL fail closed.

#### Scenario: Auto-accept records the package

- **WHEN** grill auto-settles a reversible in-scope recommendation
- **THEN** the Decisions node SHALL record recommendation, rationale, alternatives, risk, and evidence
- **AND** provenance SHALL remain `settled-by: auto-accept`

#### Scenario: DecisionRequest records the package

- **WHEN** grill creates a `DecisionRequest` for contradictory requirements
- **THEN** the node SHALL record recommendation, rationale, alternatives, risk, and evidence
- **AND** `typed_request` SHALL be `DecisionRequest`

---

### Requirement: Grill CapabilityRequest SHALL name provider, live probe, and resume condition

When grill pauses for missing external ability or information, the `CapabilityRequest` SHALL name the missing capability or information, provider, exact live probe, and resume condition. A condition that can become true without supplied input SHALL be an external-condition wait. Grill SHALL NOT pause that case as `specification-decision`.

#### Scenario: Missing external input names the probe

- **WHEN** a node needs information that is not in the repository, forge, configuration, or declared dependencies
- **THEN** grill SHALL create a `CapabilityRequest` that names provider, live probe, and resume condition
- **AND** SHALL pause only that issue

#### Scenario: External condition does not become specification-decision

- **WHEN** a required docs PR is not yet on the trusted base and no supplied input is required
- **THEN** grill SHALL wait on that external condition
- **AND** SHALL NOT record `specification-decision` for that wait
