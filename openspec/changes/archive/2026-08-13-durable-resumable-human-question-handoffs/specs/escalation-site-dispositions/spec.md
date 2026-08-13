## ADDED Requirements

### Requirement: Human-question handoff production sites SHALL be inventoried with closed safety dispositions

Every production site that creates a human-question handoff, refuses an unauthorized or unidentified answer, refuses resume for stale/superseded/expired/malformed handoffs, or fails closed on unresolved authority routing SHALL appear in the escalation-site disposition inventory. Integrity sites (unauthorized answer, malformed record, unresolved authority routing, stale resume) SHALL use disposition `deliberately-fail-closed`. Pending human wait SHALL NOT be wrapped as `transient-retryable` auto-approval or auto-retry of authority. Adding a new handoff escalation emitter without an inventory row SHALL fail the existing disposition drift-guard.

#### Scenario: Unauthorized answer site is deliberately fail-closed

- **WHEN** the inventory is inspected for the unauthorized handoff-answer site
- **THEN** its disposition SHALL be `deliberately-fail-closed`
- **AND** the site SHALL NOT apply a transient retry wrapper that records success without authorization

#### Scenario: Pending handoff wait is not transient-retryable authority

- **WHEN** an item waits on a pending handoff
- **THEN** the wait site SHALL NOT be dispositioned as `transient-retryable` for the purpose of inventing an answer
- **AND** exhaustion of any wait budget SHALL escalate with a typed reason without silent approve

#### Scenario: Missing handoff inventory row fails the drift guard

- **WHEN** a new production handoff create or resume-refusal emitter is added without an inventory row
- **THEN** the disposition drift-guard test SHALL fail
