## ADDED Requirements

### Requirement: Pre-code attestation escalation sites SHALL declare closed dispositions

Every production escalation emitter introduced for the pre-code attestation gate — including
unauthorized approval, separation-of-duty failure, unresolved ownership, configuration-error
surfaces that block advancement, attestation expiration invalidation that blocks implementing,
attestor-unavailable / waiting-for-human holds, and post-approval scope mismatch returns to gate —
SHALL appear in the escalation-site inventory with exactly one closed disposition:

- Integrity and authority failures (unauthorized, SoD, unresolved ownership, reject handling that
  blocks implementing, config-error fail-closed, scope-mismatch invalidation) SHALL be
  `deliberately-fail-closed`.
- Waiting for an authorized human SHALL use durable wait/human-input surfaces and SHALL NOT mint a
  new unrecoverable park class. Wait-budget exhaustion under default `resume_safe` mode SHALL remain
  operator-visible and SHALL NOT silent-approve; optional `hard_block` mode MAY hard-block under an
  inventoried site.

New emitters without inventory rows SHALL fail the disposition drift-guard.

#### Scenario: integrity sites are deliberately fail-closed

- **WHEN** the inventory is inspected for pre-code attestation unauthorized, SoD, unresolved-ownership, and config-error sites
- **THEN** each SHALL carry disposition `deliberately-fail-closed`

#### Scenario: wait sites do not invent a permanent park class

- **WHEN** the pre-code gate waits for an authorized human attestation
- **THEN** the site SHALL use the durable wait / human-input request surface (or an inventoried equivalent)
- **AND** SHALL NOT introduce a new terminal park stage solely for attestor-unavailable

#### Scenario: missing inventory row fails the guard

- **WHEN** a new production `setBlocked` or authority-class `needs-human` emitter is added for pre-code attestation without an inventory row
- **THEN** the disposition drift-guard test SHALL fail

#### Scenario: resume_safe exhaustion is not silent approve

- **WHEN** wait mode is `resume_safe` and the wait budget exhausts without attestation
- **THEN** the inventoried outcome SHALL NOT clear the gate as approved
- **AND** SHALL NOT enter `implementing` without a valid attestation
)
