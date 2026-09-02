## MODIFIED Requirements

### Requirement: The recovery policy SHALL be a machine-readable, validated document keyed by blocker class

The engine SHALL carry a machine-readable recovery policy that maps every `DurableBlockerClass`
member to a permitted set of recovery recipes, a per-strategy attempt bound, a backoff schedule, and a
lifecycle outcome. The class-wide `retry_budget` field MAY remain as a compatibility projection. It
SHALL NOT be the production authority that hides a later applicable recipe or ends RecoverySupervisor
ownership. The policy SHALL be compiled into the run contract at initialization. Compilation SHALL
refuse a policy that omits any class, that names a recipe for a class whose entry does not permit
it, or that is otherwise malformed, as a validation failure — the policy SHALL fail closed rather
than default a missing class to an open retry.

#### Scenario: Policy covers every class

- **WHEN** the compiled recovery policy is inspected
- **THEN** it SHALL contain a well-formed entry for every value in `DurableBlockerClass`
- **AND** no class SHALL be absent

#### Scenario: A missing class entry fails compilation closed

- **WHEN** a recovery policy that omits one class is compiled
- **THEN** compilation SHALL fail as a validation error naming the missing class
- **AND** no run directory SHALL be created

#### Scenario: A malformed recipe reference fails compilation

- **WHEN** a policy entry names a recovery recipe its class does not permit, or omits its retry
  budget or terminal outcome
- **THEN** compilation SHALL fail as a validation error naming the offending class

#### Scenario: Class-wide remaining budget does not hide a later recipe

- **WHEN** a class lists more than one applicable recipe
- **AND** earlier recipes have consumed a former class-wide retry budget
- **AND** a later applicable recipe has not spent its own bound
- **THEN** that later recipe SHALL remain claimable
- **AND** compilation SHALL still require a well-formed per-class entry

---

### Requirement: Unknown or ambiguous blockers SHALL fail closed

The engine SHALL fail closed when a diagnostic cannot be resolved to exactly one
`DurableBlockerClass` because its version or reason code is unknown, no projection matches, or more
than one projection matches. It SHALL record a typed `workflow-engine-defect` carrying the item,
diagnostic identity, and ambiguity; SHALL NOT guess a class or infer human authority from labels or
prose; and SHALL route the defect through the compiled bounded recovery policy before any Cooling or
typed request. If no safe recipe exists or every applicable strategy is exhausted, the engine SHALL
enter Cooling or an external-condition wait, not a needs-human or human-authority stop, and not a
mechanical `run_fatal` lifecycle terminal.

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

- **WHEN** a classification failure has a safe permitted recovery recipe with remaining per-strategy budget
- **THEN** the engine SHALL allow that recipe to be claimed before entering Cooling
- **AND** it SHALL enter Cooling only after no safe permitted attempt remains
- **AND** it SHALL NOT persist `run_fatal` as the lifecycle outcome of that exhaustion

---

### Requirement: Blocker evidence SHALL be fingerprinted and repeated identical evidence SHALL be bounded

Each durable-run block SHALL record an evidence fingerprint computed by a pure function over the
block's normalized evidence, so that structurally identical failures produce identical
fingerprints. The engine SHALL count consecutive recovery attempts on an item whose block carries
a fingerprint identical to the item's prior block. Once that count reaches the policy's configured
repeated-evidence limit, the engine SHALL advance the Recovery Episode strategy cursor or enter
Cooling with a future `next_eligible_at`, even when a later applicable strategy still has remaining
capacity. It SHALL NOT record a terminal `repeated_no_progress` stop that ends ownership. A block
whose fingerprint differs from the prior block SHALL reset the item's repeated-evidence count.

#### Scenario: Identical evidence cannot consume an unbounded retry loop

- **WHEN** an item blocks with the same evidence fingerprint on consecutive attempts up to the
  repeated-evidence limit
- **THEN** RecoverySupervisor SHALL advance the strategy cursor or persist Cooling naming the item
  and the fingerprint
- **AND** the Logical Operation SHALL remain owned
- **AND** the engine SHALL NOT persist `repeated_no_progress` as a lifecycle terminal stop

#### Scenario: Differing evidence resets the repeat count

- **WHEN** a subsequent block on the same item carries a different fingerprint
- **THEN** the item's repeated-evidence count SHALL reset to zero

#### Scenario: Fingerprints are computed by a pure, tested function

- **WHEN** the fingerprint function is given two normalized-evidence inputs that differ only in
  incidental formatting
- **THEN** it SHALL return the same fingerprint for both
- **AND** it SHALL return distinct fingerprints for materially different evidence

---

### Requirement: Classification, actions, evidence, and outcome SHALL be persisted and emitted

For every recovery attempt the engine SHALL persist in the ledger a record carrying the item id,
authoritative candidate identity, blocker class, recovery action, evidence fingerprint, stable
attempt id, sequence, remaining per-strategy budget, durable eligibility time, completion time, error, and
outcome (`started`, `recovered`, `superseded`, `exhausted`, `repeated_no_progress`,
`needs_human`, `human_authority`, or `failed`).
The Recovery Episode that owns those attempts SHALL also persist invariant, candidate epoch,
strategy cursor, attempts per strategy, and `next_eligible_at`.
The engine SHALL durably record `started` and charge an attempt before executing its side effect.
It SHALL determine completion from the actual result and SHALL NOT record `recovered` for an action
that did not succeed. Success, failure, timeout, and process death after `started` SHALL consume the
attempt of that strategy. An inapplicable deterministic recipe SHALL be recorded as a skip and SHALL
NOT consume a later strategy's bound. The engine SHALL emit a Pipeline-native event for every start
and result. Persistence SHALL survive restart so a resumed engine reads and reconciles the same
history. Outcome `exhausted` SHALL mean that strategy's bound is spent. It SHALL NOT mean the
Logical Operation is terminal.

#### Scenario: A recovery attempt is recorded and emitted

- **WHEN** a recovery action is started and later completes for a blocked item
- **THEN** the ledger SHALL carry the attempt's item, candidate identity, class, action,
  fingerprint, attempt id, sequence, remaining budget, and outcome
- **AND** Pipeline-native start and result events SHALL be emitted

#### Scenario: A failed recovery action is recorded and charged

- **WHEN** the recovery action started for a blocked item does not succeed
- **THEN** the ledger SHALL record the attempt's outcome as `failed`
- **AND** the item SHALL not be recorded as recovered
- **AND** the claimed recovery budget unit SHALL remain consumed

#### Scenario: Recovery history survives restart

- **WHEN** a new engine process resumes the run after recovery attempts were recorded
- **THEN** it SHALL read the same per-attempt identity, classification, action, budget, error, and
  outcome from the durable store
- **AND** it SHALL reconcile any `started` attempt before replay

#### Scenario: Episode cursor survives with the attempts

- **WHEN** a Recovery Episode has advanced its strategy cursor and recorded `next_eligible_at`
- **AND** a new engine process resumes the run
- **THEN** it SHALL read the same cursor and `next_eligible_at`
- **AND** SHALL NOT restart at the first recipe solely because the process restarted

---

### Requirement: Independent eligible items SHALL continue when policy permits

When an item is blocked for recovery or Cooling, the engine SHALL allow a dependency-
independent eligible item to continue when the active disposition does not prohibit sibling
progress. The engine SHALL consult and execute safe permitted recovery before entering Cooling.
A policy entry SHALL NOT make its own recipe unreachable by terminalizing
the run at the blocking transition. Only a current canonical `human-decision-required` diagnostic
MAY create an immediate human hold without an automated recipe. An engine-owned failure
SHALL enter Cooling after reconciliation proves no safe permitted attempt remains. Sibling
continuation SHALL respect the existing active-item and merge-barrier invariants.

#### Scenario: A non-run-fatal block lets an independent item proceed

- **WHEN** an item is blocked under a class whose policy permits sibling progress and an eligible
  item with no dependency on the blocked item exists
- **THEN** the engine SHALL permit that independent item to be started
- **AND** the active-item and merge-barrier invariants SHALL still hold

#### Scenario: Recovery runs before an engine-owned run-fatal stop

- **WHEN** an engine-owned blocker has a safe permitted recipe and unconsumed per-strategy budget
- **THEN** the engine SHALL allow the recipe to be claimed and executed before entering Cooling
- **AND** the blocked item SHALL remain eligible for recovery

#### Scenario: Exhausted engine-owned recovery stops without human authority

- **WHEN** reconciliation proves that an engine-owned blocker has exhausted every safe permitted
  attempt
- **THEN** RecoverySupervisor SHALL persist Cooling or an external-condition wait
- **AND** the outcome SHALL NOT be recorded as needs-human, human-authority, or a mechanical
  `run_fatal` lifecycle stop
- **AND** a proven-independent sibling SHALL remain schedulable
