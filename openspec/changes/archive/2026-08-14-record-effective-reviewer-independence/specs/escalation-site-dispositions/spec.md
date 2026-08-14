## ADDED Requirements

### Requirement: Independent-quorum and no-usable-reviewers escalations SHALL be inventory sites

Production escalation emitters for review independent-quorum unmet and review no-usable-reviewers SHALL each appear as rows in the escalation-site disposition inventory. The independent-quorum unmet site SHALL declare disposition `deliberately-fail-closed` (coverage integrity: do not auto-approve when required independent coverage is missing). The no-usable-reviewers site SHALL declare a closed disposition of `deliberately-fail-closed` or `transient-retryable` only when the underlying failure class is a documented transient spawn/timeout eligible for the single substitute wave; after that bound it SHALL escalate as a typed engine-owned failure and SHALL NOT default to open-ended product-judgment human hold. Each row SHALL name module path or stable site id, trigger, disposition, and canonical reason projection. The disposition drift-guard SHALL fail if either emitter is added without an inventory row.

#### Scenario: quorum unmet site is deliberately fail-closed

- **WHEN** the inventory is inspected for the independent-quorum-unmet review site
- **THEN** its disposition SHALL be `deliberately-fail-closed`
- **AND** the site SHALL NOT be wrapped by an unbounded automatic retry that produces a coverage-complete approve

#### Scenario: no usable reviewers site is inventory-backed

- **WHEN** the inventory is inspected for the no-usable-reviewers review site
- **THEN** it SHALL have exactly one closed safety disposition
- **AND** SHALL name a typed reason projection for stage diagnostics

#### Scenario: missing inventory row fails the drift guard

- **WHEN** a production setBlocked (or equivalent park) for quorum_unmet or no_usable_reviewers is added without an inventory row
- **THEN** the disposition drift-guard test SHALL fail
- **AND** the failure SHALL identify the missing site
