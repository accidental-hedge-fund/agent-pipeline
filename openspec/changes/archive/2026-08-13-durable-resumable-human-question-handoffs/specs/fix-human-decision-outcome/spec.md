## ADDED Requirements

### Requirement: An accepted needs-human-decision park SHALL create a durable authority-bearing human-question handoff

When the fix stage parks a round on at least one accepted needs-human-decision declaration, it SHALL create one durable human-question handoff per accepted declaration (or idempotently reuse an existing pending handoff with the same finding key, fingerprint, and reviewed SHA). Each handoff SHALL set `authority_mode: authority`, bind the declaration's decision request as the bounded `question`, record finding key, fingerprint, and reviewed SHA as `human-decision-required` evidence, set `candidate_sha` to that reviewed SHA, and set a deterministic resume target consistent with the existing human-driven unblock/override flow. The handoff SHALL NOT resolve or suppress the finding, SHALL NOT advance the item, and SHALL NOT replace the durable readable evidence comment already required for the declaration.

#### Scenario: Valid product-decision park creates a pending handoff

- **WHEN** a fix round parks on an accepted `product-decision` declaration for finding key K at reviewed SHA S
- **THEN** a pending handoff SHALL exist bound to K, the declaration fingerprint, and SHA S
- **AND** `authority_mode` SHALL be `authority`
- **AND** the finding SHALL remain blocking

#### Scenario: Duplicate park is idempotent for the same declaration identity

- **WHEN** the same accepted declaration identity (key, fingerprint, reviewed SHA) would create a handoff that already exists as pending
- **THEN** the engine SHALL NOT create a second active pending handoff for that identity
- **AND** the existing handoff id SHALL remain the authoritative handle

#### Scenario: Handoff create failure does not invent authority from the park alone

- **WHEN** handoff persistence fails after an accepted declaration park
- **THEN** the item SHALL remain blocked under the existing human-decision blocker behavior
- **AND** the engine SHALL NOT treat the declaration as resolved
- **AND** evidence of the handoff create failure SHALL be preserved

#### Scenario: Non-authority manual repair is not used for accepted human-decision declarations

- **WHEN** a handoff is created from an accepted needs-human-decision declaration
- **THEN** it SHALL NOT be typed solely as non-authority `manual_repair`
- **AND** SHALL carry the declaration's authority evidence fields
