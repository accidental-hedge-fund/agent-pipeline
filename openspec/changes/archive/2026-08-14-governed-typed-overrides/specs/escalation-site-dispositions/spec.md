## ADDED Requirements

### Requirement: Override governance integrity and expiry sites SHALL be inventoried with closed dispositions

The escalation-site inventory SHALL include production sites that refuse override recording (unauthorized, SoD violation, missing required evidence, unknown class, malformed target) and sites that deny unblock because a decision is expired or invalidated. Integrity refusal sites SHALL be dispositioned `deliberately-fail-closed` (no automatic retry that would mint authority). Expiry and drift-driven loss of active status SHALL return the finding to the ordinary blocking set with a typed reason; they SHALL NOT invent a new unrecoverable park class and SHALL NOT silently re-approve.

#### Scenario: unauthorized override record is fail-closed

- **WHEN** the inventory is inspected for override-governance record refusal sites
- **THEN** unauthorized, SoD, missing-evidence, and unknown-class refusals SHALL be listed
- **AND** each SHALL carry disposition `deliberately-fail-closed`

#### Scenario: expiry does not create a new park class

- **WHEN** an override decision expires or is invalidated by subject drift
- **THEN** the engine SHALL stop treating it as active for unblock
- **AND** SHALL project a typed reason compatible with the escalation inventory
- **AND** SHALL NOT introduce a new unrecoverable park class solely for override expiry

#### Scenario: renewal-lite success is not an escalation

- **WHEN** renewal-lite appends a valid successor decision without human action
- **THEN** that path SHALL NOT be classified as a human-authority escalation site
- **AND** SHALL NOT charge a product-judgment handoff

### Requirement: Drift-blocked renewal-lite SHALL escalate with a typed resume-safe outcome

When renewal mode is `lite` and auto-renew is blocked by fingerprint, region, or subject drift, the engine SHALL emit a typed escalation or status reason that is default-resume-safe: the finding blocks until a human records a new authorized decision or the finding is fixed. The site SHALL NOT auto-approve and SHALL NOT be wrapped as a transient infrastructure retry.

#### Scenario: drift blocks lite renewal with typed reason

- **WHEN** lite renewal is attempted and the live finding fingerprint differs from the prior decision
- **THEN** the engine SHALL NOT auto-renew
- **AND** SHALL surface a typed reason that the finding is again blocking pending human renewal or fix
- **AND** the inventory disposition for that site SHALL not be `transient-retryable`
