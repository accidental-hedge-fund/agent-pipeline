## MODIFIED Requirements

### Requirement: Unknown or ambiguous blockers SHALL fail closed

The engine SHALL fail closed when a diagnostic cannot be resolved to exactly one
`DurableBlockerClass` because its version or reason code is unknown, no projection matches, or more
than one projection matches. It SHALL record a typed `workflow-engine-defect` carrying the item,
diagnostic identity, and ambiguity; SHALL NOT guess a class or infer human authority from labels or
prose; and SHALL route the defect through the compiled bounded recovery policy. If no safe recipe exists or the budget is exhausted, the engine SHALL enter Cooling or an external-condition wait. It SHALL NOT emit a terminal system-failure stop, an ownerless terminal, or a needs-human or human-authority stop.

#### Scenario: An unmatched blocker becomes an engine-owned classification failure

- **WHEN** a blocker matches no `DurableBlockerClass`
- **THEN** it SHALL be recorded as a typed `workflow-engine-defect` naming the item and diagnostic
- **AND** it SHALL NOT emit a needs-human or human-authority outcome

#### Scenario: An ambiguous blocker does not silently retry or ask a human to classify it

- **WHEN** a blocker matches more than one class
- **THEN** the engine SHALL fail closed with a typed engine-owned classification failure naming the
  ambiguity
- **AND** it SHALL NOT guess a recovery recipe or infer authority from labels or prose

#### Scenario: Classification failure observes bounded policy before terminalization

- **WHEN** a classification failure has a safe permitted recovery recipe with remaining budget
- **THEN** the engine SHALL allow that recipe to be claimed before entering Cooling
- **AND** after no safe permitted attempt remains it SHALL enter Cooling
- **AND** it SHALL NOT record a terminal system failure or human ownership solely for that exhaustion

---

### Requirement: Blocker evidence SHALL be fingerprinted and repeated identical evidence SHALL be bounded

Each durable-run block SHALL record an evidence fingerprint computed by a pure function over the
block's normalized evidence, so that structurally identical failures produce identical
fingerprints. The engine SHALL count consecutive recovery attempts on an item whose block carries
a fingerprint identical to the item's prior block. Once that count reaches the policy's configured
repeated-evidence limit, the engine SHALL enter Cooling for that item, name the item and the repeated
fingerprint, and SHALL NOT repeat the exhausted deterministic action indefinitely. The engine SHALL
NOT refuse independent sibling transitions, SHALL NOT grant human authority, and SHALL NOT record an
ownerless terminal solely for that limit, even when the item's class recovery budget still has
remaining capacity. A block whose fingerprint differs from the prior block SHALL reset the item's
repeated-evidence count.

#### Scenario: Identical evidence cannot consume an unbounded retry loop

- **WHEN** an item blocks with the same evidence fingerprint on consecutive attempts up to the
  repeated-evidence limit
- **THEN** that item SHALL enter Cooling naming the item and the fingerprint
- **AND** the engine SHALL NOT repeat the exhausted deterministic action indefinitely
- **AND** independent siblings SHALL remain schedulable
- **AND** the outcome SHALL NOT be human ownership

#### Scenario: Differing evidence resets the repeat count

- **WHEN** a subsequent block on the same item carries a different fingerprint
- **THEN** the item's repeated-evidence count SHALL reset to zero

#### Scenario: Fingerprints are computed by a pure, tested function

- **WHEN** the fingerprint function is given two normalized-evidence inputs that differ only in
  incidental formatting
- **THEN** it SHALL return the same fingerprint for both
- **AND** it SHALL return distinct fingerprints for materially different evidence

---

### Requirement: Permitted recovery recipes SHALL never cross an authority gate

No recovery recipe permitted by the policy SHALL perform a merge, release, credential, or deploy action, and no recipe SHALL widen an authority grant the contract does not hold. The `missing-authority` class SHALL map to a typed-input wait only for a current protected `AuthorityRequest`. The `specification-decision` class SHALL map to a typed-input wait only for an irreducible `DecisionRequest` after the shared classifier. Those waits SHALL keep the Logical Operation owned. Pipeline SHALL NOT assign either class until that classifier has run. Missing information and unavailable capability SHALL NOT use these classes. This reinforces, and never bypasses, the engine's existing authority gates. Auto-settle SHALL NOT become a block of either class.

#### Scenario: No recipe performs a gated action

- **WHEN** the permitted recovery recipes for every class are inspected
- **THEN** none SHALL include a merge, release, credential, or deploy action

#### Scenario: Missing-authority routes to a human, not a retry

- **WHEN** an item blocks with class `missing-authority` after the classifier emits a protected `AuthorityRequest`
- **THEN** the policy outcome SHALL be a typed-input wait for that AuthorityRequest
- **AND** no automated recovery recipe SHALL be attempted
- **AND** the Logical Operation SHALL remain owned

#### Scenario: Specification-decision routes to a human, not a retry

- **WHEN** an item blocks with class `specification-decision` after the classifier emits an irreducible `DecisionRequest`
- **THEN** the policy outcome SHALL be a typed-input wait for that product decision
- **AND** no automated recovery recipe SHALL be attempted
- **AND** the Logical Operation SHALL remain owned

#### Scenario: Reversible choice is not specification-decision

- **WHEN** the classifier auto-settles a reversible in-scope recommendation
- **THEN** Pipeline SHALL NOT record `specification-decision` or `missing-authority`
- **AND** SHALL NOT start a typed-input wait or human-authority stop
