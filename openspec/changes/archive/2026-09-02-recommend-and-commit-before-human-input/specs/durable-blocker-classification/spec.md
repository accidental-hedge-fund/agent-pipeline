## MODIFIED Requirements

### Requirement: Permitted recovery recipes SHALL never cross an authority gate

No recovery recipe permitted by the policy SHALL perform a merge, release, credential, or deploy action, and no recipe SHALL widen an authority grant the contract does not hold. The `missing-authority` class SHALL map to a terminal human-authority outcome only for a current protected `AuthorityRequest`. The `specification-decision` class SHALL map to a terminal human-authority outcome only for an irreducible `DecisionRequest` after the shared classifier. Pipeline SHALL NOT assign either class until that classifier has run. Missing information and unavailable capability SHALL NOT use these classes. This reinforces, and never bypasses, the engine's existing authority gates. Auto-settle SHALL NOT become a block of either class.

#### Scenario: No recipe performs a gated action

- **WHEN** the permitted recovery recipes for every class are inspected
- **THEN** none SHALL include a merge, release, credential, or deploy action

#### Scenario: Missing-authority routes to a human, not a retry

- **WHEN** an item blocks with class `missing-authority` after the classifier emits a protected `AuthorityRequest`
- **THEN** the policy outcome SHALL be a terminal human-authority stop
- **AND** no automated recovery recipe SHALL be attempted

#### Scenario: Specification-decision routes to a human, not a retry

- **WHEN** an item blocks with class `specification-decision` after the classifier emits an irreducible `DecisionRequest`
- **THEN** the policy outcome SHALL be a terminal human-authority stop for a product decision
- **AND** no automated recovery recipe SHALL be attempted

#### Scenario: Reversible choice is not specification-decision

- **WHEN** the classifier auto-settles a reversible in-scope recommendation
- **THEN** Pipeline SHALL NOT record `specification-decision` or `missing-authority`
- **AND** SHALL NOT start a human-authority stop

## ADDED Requirements

### Requirement: Missing information SHALL NOT project as specification-decision

Pipeline SHALL project missing information and `human-context-required` as a `CapabilityRequest` or an external-condition wait. That projection SHALL NOT use durable class `specification-decision` or `missing-authority`. Product decisions and protected authority SHALL remain distinct after the shared classifier.

#### Scenario: Human-context-required is not specification-decision

- **WHEN** a diagnostic reason is `human-context-required` and the missing data is information or context
- **THEN** projection SHALL NOT yield `specification-decision`
- **AND** SHALL NOT yield `missing-authority`

#### Scenario: Capability gap is not missing-authority

- **WHEN** the classifier emits a `CapabilityRequest` for an unavailable credential
- **THEN** the durable class SHALL NOT be `missing-authority`
- **AND** SHALL NOT be `specification-decision`
