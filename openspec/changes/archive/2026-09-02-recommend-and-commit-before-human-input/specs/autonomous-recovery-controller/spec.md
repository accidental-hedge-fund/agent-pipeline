## MODIFIED Requirements

### Requirement: Human holds SHALL require positive current product or authority evidence

The controller SHALL create a human hold only when fresh dispatch evidence carries a canonical `human-decision-required` diagnostic whose structured blocker kind is also `human-decision-required` and whose non-empty authority evidence names a `product-decision` or `authority` finding key/fingerprint at the freshly observed candidate SHA, and only after the shared typed-request-resolution classifier has run on that evidence. A `product-decision` category SHALL NOT by itself create a human hold: the classifier SHALL auto-settle a reversible in-scope authorized recommendation, emit a `DecisionRequest` only for an irreducible product choice, emit a `CapabilityRequest` for missing information or input-requiring capability, and emit an `AuthorityRequest` only for missing protected authority. A `pipeline:blocked` label, a `blocked_needs_human` outcome without that diagnostic, stale or missing authority evidence, an exhausted mechanical budget, merge conflict, external dependency, or OpenSpec validation failure SHALL NOT satisfy this predicate. Engine-owned exhaustion SHALL enter Cooling or an external-condition wait without emitting `human_intervention`. Engine-owned exhaustion SHALL NOT terminate as a typed system failure, ownerless terminal, or supervisor STOP.

#### Scenario: Attested product decision creates a hold

- **WHEN** fresh dispatch evidence carries a valid `human-decision-required` diagnostic with the matching structured blocker kind, sanctioned `product-decision` category, finding identity, and current reviewed SHA
- **AND** the shared classifier emits an irreducible `DecisionRequest`
- **THEN** the controller SHALL create a resumable human hold for that item
- **AND** the hold SHALL retain the diagnostic evidence and reconciled candidate identity

#### Scenario: Reversible product recommendation auto-settles

- **WHEN** fresh dispatch evidence carries a valid `human-decision-required` diagnostic with category `product-decision`
- **AND** the shared classifier auto-settles the recommendation
- **THEN** the controller SHALL NOT create a human hold
- **AND** SHALL NOT emit `human_intervention` for that recommendation

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
