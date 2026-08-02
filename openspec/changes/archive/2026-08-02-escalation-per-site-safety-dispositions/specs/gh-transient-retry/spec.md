## ADDED Requirements

### Requirement: Transient-retryable gh mutation and read sites SHALL share bounded retry classification

Transient-retryable gh mutation and read sites SHALL share bounded retry classification through
`ghRun` (or an equivalent wrapper that reuses `isTransientGhError` and exponential backoff).
Production sites dispositioned `transient-retryable` — including label add/remove/edit paths and
other non-attestation reads/mutations that currently fail closed on the first transport error —
SHALL use that wrapper. A transient HTTP 5xx, rate-limit, or network blip SHALL retry within the
configured budget. After success, the caller SHALL continue without parking the issue as a
product block. After exhaustion, the caller SHALL escalate with a canonical infrastructure /
engine-owned reason, not product judgment.

Attestation-grade identity sites dispositioned `deliberately-fail-closed` SHALL remain outside
this automatic retry wrapper requirement (they MAY still use `ghRun` defaults but MUST NOT treat
a missing actor as a soft success).

#### Scenario: Label edit 504 retries and does not product-park on success

- **WHEN** a label mutation invoked through the transient wrapper fails once with stderr
  containing HTTP 504 and succeeds on the next attempt within budget
- **THEN** the wrapper SHALL return success after retry
- **AND** the caller SHALL NOT set a product `needs-human` block solely for the transient blip

#### Scenario: Label edit 504 exhaustion stays typed engine-owned

- **WHEN** a label mutation exhausts retries on repeated HTTP 5xx
- **THEN** the escalation SHALL classify as transient infrastructure / engine-owned
- **AND** SHALL NOT be recorded as a product-judgment human hold solely from that exhaustion

#### Scenario: Deterministic 422 is not retried

- **WHEN** a gh mutation fails with HTTP 422 validation failed
- **THEN** the wrapper SHALL throw or return failure after exactly one attempt
- **AND** no backoff sleep SHALL be invoked for that deterministic class

#### Scenario: Deliberately-fail-closed actor attestation is unchanged

- **WHEN** an attestation site calls `getGhActor` and receives null
- **THEN** the site SHALL fail closed per its integrity disposition
- **AND** SHALL NOT invent a successful actor identity via retry soft-success
)