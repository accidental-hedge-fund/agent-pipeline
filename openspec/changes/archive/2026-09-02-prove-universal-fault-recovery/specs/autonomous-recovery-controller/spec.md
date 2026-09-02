## MODIFIED Requirements

### Requirement: Human holds SHALL require positive current product or authority evidence

The controller SHALL create a human hold only when fresh dispatch evidence carries a canonical
`human-decision-required` diagnostic whose structured blocker kind is also
`human-decision-required` and whose non-empty authority evidence names a `product-decision` or
`authority` finding key/fingerprint at the freshly observed candidate SHA. A `pipeline:blocked`
label, a `blocked_needs_human` outcome without that diagnostic, stale or missing authority
evidence, an exhausted mechanical budget, merge conflict, external dependency, or OpenSpec
validation failure SHALL NOT satisfy this predicate. Engine-owned exhaustion SHALL enter Cooling
or an external-condition wait without emitting `human_intervention`. Engine-owned exhaustion
SHALL NOT terminate as a typed system failure, ownerless terminal, or supervisor STOP.

#### Scenario: Attested product decision creates a hold

- **WHEN** fresh dispatch evidence carries a valid `human-decision-required` diagnostic with the
  matching structured blocker kind, sanctioned category, finding identity, and current reviewed SHA
- **THEN** the controller SHALL create a resumable human hold for that item
- **AND** the hold SHALL retain the diagnostic evidence and reconciled candidate identity

#### Scenario: Mechanical exhaustion is not human authority

- **WHEN** an OpenSpec or worktree recovery exhausts its configured budget
- **THEN** the controller SHALL enter Cooling or an external-condition wait
- **AND** it SHALL NOT create a human hold or emit `human_intervention`
- **AND** it SHALL NOT record an ownerless terminal or supervisor STOP solely for that exhaustion

#### Scenario: Candidate movement invalidates authority

- **WHEN** fresh reconciliation observes a HEAD different from the candidate SHA retained by a
  human-authority hold
- **THEN** the controller SHALL invalidate the hold and re-admit the item in the same cycle
- **AND** a remaining `pipeline:blocked` label SHALL NOT preserve the stale authority

---

### Requirement: Transient infrastructure failures SHALL NOT park as product judgment

Transient infrastructure failures SHALL classify under an engine-owned recoverable reason and
disposition `recover` (or capacity/wait where applicable), including gh HTTP 5xx / rate-limit
during label edits or other non-attestation mutations, harness throttle, and network blips.
After bounded site-local retry exhaustion, the failure SHALL enter Cooling or an
external-condition wait, or a typed Capability Request when an unavailable external capability
is current. It SHALL NOT become a typed engine-owned terminal failure or supervisor STOP. It
SHALL NOT be represented as product judgment, SHALL NOT create a human hold without the
authority predicate, and SHALL NOT be the sole cause of a `needs-human` park labeled as a
product block.

#### Scenario: Label-edit 504 does not become a product hold

- **WHEN** a gh label edit fails with HTTP 504 and the site disposition is `transient-retryable`
- **THEN** the engine SHALL classify the failure as transient infrastructure
- **AND** SHALL retry within the configured budget
- **AND** SHALL NOT park the issue as a product or human-authority block solely because of that
  blip when a retry succeeds or when exhaustion remains typed engine-owned Cooling or wait

#### Scenario: Repair-budget exhaustion stays engine-owned

- **WHEN** bounded recovery or site-local retry budget is exhausted for a mechanical class
- **THEN** the outcome SHALL be Cooling or an external-condition wait
- **AND** the controller SHALL NOT emit `human_intervention` solely from that exhaustion
- **AND** the controller SHALL NOT record an ownerless terminal or supervisor STOP solely from
  that exhaustion
