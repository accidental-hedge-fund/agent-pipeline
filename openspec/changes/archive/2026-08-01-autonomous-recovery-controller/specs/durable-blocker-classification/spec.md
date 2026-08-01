## MODIFIED Requirements

### Requirement: Unknown or ambiguous blockers SHALL fail closed

The engine SHALL fail closed when a diagnostic cannot be resolved to exactly one
`DurableBlockerClass` because its version or reason code is unknown, no projection matches, or more
than one projection matches. It SHALL record a typed `workflow-engine-defect` carrying the item,
diagnostic identity, and ambiguity; SHALL NOT guess a class or infer human authority from labels or
prose; and SHALL route the defect through the compiled bounded recovery policy before any terminal
system stop. If no safe recipe exists or the budget is exhausted, the engine SHALL emit a terminal
system-failure stop, not a needs-human or human-authority stop.

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
- **THEN** the engine SHALL allow that recipe to be claimed before recording a terminal stop
- **AND** it SHALL record a terminal system failure only after no safe permitted attempt remains

### Requirement: Classification, actions, evidence, and outcome SHALL be persisted and emitted

For every recovery attempt the engine SHALL persist in the ledger a record carrying the item id,
authoritative candidate identity, blocker class, recovery action, evidence fingerprint, stable
attempt id, sequence, remaining budget, durable eligibility time, completion time, error, and
outcome (`started`, `recovered`, `superseded`, `exhausted`, `repeated_no_progress`,
`needs_human`, `human_authority`, or `failed`).
The engine SHALL durably record `started` and charge an attempt before executing its side effect.
It SHALL determine completion from the actual result and SHALL NOT record `recovered` for an action
that did not succeed. Success, failure, timeout, and process death after `started` SHALL consume the
attempt. The engine SHALL emit a Pipeline-native event for every start and result. Persistence SHALL
survive restart so a resumed engine reads and reconciles the same history.

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

### Requirement: Independent eligible items SHALL continue when policy permits

When an item is blocked for recovery, the engine SHALL allow a dependency-
independent eligible item to continue when the active disposition does not prohibit sibling
progress. The engine SHALL consult and execute safe permitted recovery before recording a
run-fatal system stop; a policy entry SHALL NOT make its own recipe unreachable by terminalizing
the run at the blocking transition. Only a current canonical `human-decision-required` diagnostic
MAY create an immediate human hold without an automated recipe. An engine-owned failure
MAY become run-fatal only after reconciliation proves no safe permitted attempt remains. Sibling
continuation SHALL respect the existing active-item and merge-barrier invariants.

#### Scenario: A non-run-fatal block lets an independent item proceed

- **WHEN** an item is blocked under a class whose policy permits sibling progress and an eligible
  item with no dependency on the blocked item exists
- **THEN** the engine SHALL permit that independent item to be started
- **AND** the active-item and merge-barrier invariants SHALL still hold

#### Scenario: Recovery runs before an engine-owned run-fatal stop

- **WHEN** an engine-owned blocker has a safe permitted recipe and unconsumed budget
- **THEN** the engine SHALL allow the recipe to be claimed and executed before recording a
  run-fatal stop
- **AND** the blocked item SHALL remain eligible for recovery

#### Scenario: Exhausted engine-owned recovery stops without human authority

- **WHEN** reconciliation proves that an engine-owned blocker has exhausted every safe permitted
  attempt and no sibling can progress
- **THEN** the run MAY record a terminal system-failure stop
- **AND** the stop SHALL NOT be recorded as needs-human or human-authority
