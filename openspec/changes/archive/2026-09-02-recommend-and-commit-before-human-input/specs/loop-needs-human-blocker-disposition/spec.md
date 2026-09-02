## ADDED Requirements

### Requirement: A product-decision diagnostic SHALL run the shared classifier before a human hold

When a blocked dispatch carries a current canonical `human-decision-required` diagnostic with category `product-decision`, the supervisor SHALL run the shared typed-request-resolution classifier before it creates or retains a human hold. Auto-settle SHALL proceed under existing authority. An irreducible `DecisionRequest` MAY create a resumable hold. Missing information or input-requiring capability SHALL become a `CapabilityRequest` or external-condition wait and SHALL NOT be recorded as `missing-authority`. Protected authority SHALL remain an `AuthorityRequest`. Unknown errors, low confidence alone, stale labels, and retry exhaustion SHALL NOT satisfy this hold.

#### Scenario: Product-decision auto-settle skips the hold

- **WHEN** a blocked dispatch carries a current `human-decision-required` diagnostic with category `product-decision`
- **AND** the classifier auto-settles the recommendation
- **THEN** the supervisor SHALL NOT create a needs-human hold
- **AND** SHALL NOT emit `human_intervention`
- **AND** SHALL persist the classifier resolution package in the durable decision record before reverting the item to pending

#### Scenario: Irreducible DecisionRequest still holds

- **WHEN** a blocked dispatch carries a current `human-decision-required` diagnostic with category `product-decision`
- **AND** the classifier emits an irreducible `DecisionRequest`
- **THEN** the supervisor SHALL move the item to a `paused` or `waiting` hold
- **AND** SHALL retain the candidate and request evidence needed to validate a later answer
- **AND** the hold SHALL persist the classifier `DecisionRequest` package

#### Scenario: Stale label still is not authority

- **WHEN** live truth carries `pipeline:blocked` or `pipeline:needs-human` without current classifier evidence
- **THEN** the supervisor SHALL NOT create a human hold from that label
