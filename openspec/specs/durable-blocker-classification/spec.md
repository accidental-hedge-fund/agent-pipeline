# durable-blocker-classification Specification

## Purpose
TBD - created by archiving change durable-run-blocker-classification. Update Purpose after archive.
## Requirements
### Requirement: The engine SHALL classify every durable-run blocker into a closed typed set
The engine SHALL define a `DurableBlockerClass` string enum comprising exactly
`transient-rate-limit`, `workflow-state`, `implementation-ci`, `review-findings`,
`environment-auth`, `specification-decision`, `missing-authority`, `upstream-dependency`, and
`workflow-engine-defect`. Every durable-run transition into `blocked` SHALL carry exactly one
member, and its blocked theme SHALL use that member as the budget key. Missing and unknown classes
SHALL fail validation without changing durable state. An already-blocked item SHALL require an
intervening successful recovery before another block can count as repeated evidence.

#### Scenario: Review findings carry their own durable class
- **WHEN** an eligible review non-convergence diagnostic transitions an item into `blocked`
- **THEN** the item's blocked theme SHALL be `review-findings`
- **AND** its budget and recipe selection SHALL be independent of generic CI failures

### Requirement: The recovery policy SHALL be a machine-readable, validated document keyed by blocker class

The engine SHALL carry a machine-readable recovery policy that maps every `DurableBlockerClass`
member to a permitted set of recovery recipes, a retry budget, a backoff schedule, and a terminal
outcome. The policy SHALL be compiled into the run contract at initialization. Compilation SHALL
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

### Requirement: Blocker evidence SHALL be fingerprinted and repeated identical evidence SHALL be bounded

Each durable-run block SHALL record an evidence fingerprint computed by a pure function over the
block's normalized evidence, so that structurally identical failures produce identical
fingerprints. The engine SHALL count consecutive recovery attempts on an item whose block carries
a fingerprint identical to the item's prior block. Once that count reaches the policy's configured
repeated-evidence limit, the engine SHALL record a terminal stop naming the item and the repeated
fingerprint and refuse further recovery on that item with a stop-class failure, even when the
item's class recovery budget still has remaining capacity. A block whose fingerprint differs from
the prior block SHALL reset the item's repeated-evidence count.

#### Scenario: Identical evidence cannot consume an unbounded retry loop

- **WHEN** an item blocks with the same evidence fingerprint on consecutive attempts up to the
  repeated-evidence limit
- **THEN** the run SHALL be recorded as stopped for repeated no-progress evidence naming the item
  and the fingerprint
- **AND** the stop SHALL occur even if the class recovery budget is not yet exhausted

#### Scenario: Differing evidence resets the repeat count

- **WHEN** a subsequent block on the same item carries a different fingerprint
- **THEN** the item's repeated-evidence count SHALL reset to zero

#### Scenario: Fingerprints are computed by a pure, tested function

- **WHEN** the fingerprint function is given two normalized-evidence inputs that differ only in
  incidental formatting
- **THEN** it SHALL return the same fingerprint for both
- **AND** it SHALL return distinct fingerprints for materially different evidence

### Requirement: Permitted recovery recipes SHALL never cross an authority gate

No recovery recipe permitted by the policy SHALL perform a merge, release, credential, or deploy
action, and no recipe SHALL widen an authority grant the contract does not hold. The
`missing-authority` and `specification-decision` classes SHALL map to a terminal human-authority
outcome — a stop that hands the item to a human — rather than to any retry recipe. This reinforces,
and never bypasses, the engine's existing authority gates.

#### Scenario: No recipe performs a gated action

- **WHEN** the permitted recovery recipes for every class are inspected
- **THEN** none SHALL include a merge, release, credential, or deploy action

#### Scenario: Missing-authority routes to a human, not a retry

- **WHEN** an item blocks with class `missing-authority`
- **THEN** the policy outcome SHALL be a terminal human-authority stop
- **AND** no automated recovery recipe SHALL be attempted

#### Scenario: Specification-decision routes to a human, not a retry

- **WHEN** an item blocks with class `specification-decision`
- **THEN** the policy outcome SHALL be a terminal human-authority stop for a product decision
- **AND** no automated recovery recipe SHALL be attempted

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

### Requirement: Successful recovery SHALL resume the same pipeline item

When a recovery recipe succeeds, the engine SHALL resume the same blocked item by transitioning it
`blocked`→`in_progress` under the existing recovery-budget charge, so the item continues rather
than restarting from scratch or being skipped. The resumed item SHALL retain its prior history and
its blocker-class and evidence records.

#### Scenario: The recovered item resumes in place

- **WHEN** a recovery recipe succeeds for a blocked item
- **THEN** the same item SHALL transition `blocked`→`in_progress`
- **AND** its recorded history, blocker class, and evidence fingerprint SHALL be retained

#### Scenario: Recovery does not restart or skip the item

- **WHEN** an item recovers
- **THEN** no other item SHALL be started in its place
- **AND** the recovered item SHALL NOT be re-initialized from pending

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

### Requirement: Resumed recovery contracts SHALL acquire safety-critical policy migrations
Before a persisted contract is used for recovery, the runtime SHALL upgrade obsolete policy shapes.
A missing newly introduced class SHALL be added from the current default without replacing other
entries. An entry exactly matching a known stale default SHALL be replaced class by class with the current
default so its configured recipes are executable and reachable. A custom entry
SHALL preserve recipe order, budgets, backoff, terminal outcome, fatality, and repeat limit. The
obsolete recipe token `reauthenticate` SHALL be renamed to `verify_authentication` wherever it
appears. The complete migrated policy SHALL be compiled and malformed policies SHALL fail closed.
Migration SHALL NOT rewrite the contract's canonical hash or other immutable identity fields.

#### Scenario: Exact obsolete defaults gain current recipes
- **WHEN** a resumed contract carries the pre-#787 default workflow-state, implementation-CI, authentication, or engine-defect entry
- **THEN** each exact obsolete entry SHALL be replaced by its current default
- **AND** the workflow, CI, and engine classes SHALL include `repair_pipeline_item`

#### Scenario: Missing review class is added without resetting custom policy
- **WHEN** a resumed contract predates `review-findings` and customizes an unrelated class
- **THEN** runtime migration SHALL add the default `review-findings` entry
- **AND** SHALL preserve the unrelated customization byte-for-byte except sanctioned token renames

#### Scenario: Engine fallback remains reachable
- **WHEN** a stale engine-defect default advertises restart followed by `repair_pipeline_item` but carries only one retry/repeat unit
- **THEN** runtime migration SHALL install budgets that permit restart and the later repair action
- **AND** tests SHALL prove both actions can be claimed in order

#### Scenario: Custom policy survives migration
- **WHEN** an entry differs from the known obsolete default
- **THEN** its policy fields and recipe ordering SHALL be preserved
- **AND** only an obsolete `reauthenticate` token SHALL be renamed

#### Scenario: Malformed complete policy fails closed
- **WHEN** a resumed policy contains every class but an invalid budget, recipe, or outcome
- **THEN** migration SHALL fail with typed validation rather than silently defaulting it

#### Scenario: Contract identity is immutable
- **WHEN** runtime policy migration changes the in-memory recovery policy
- **THEN** the canonical contract hash and run identity SHALL remain unchanged

### Requirement: DurableBlockerClass SHALL be an exhaustive projection of canonical stage-diagnostic reasons

The engine SHALL treat `DurableBlockerClass` as an exhaustive pure projection of the closed
`pipeline/stage-diagnostic@1` reason-code vocabulary (via the existing
`projectPipelineReasonCode` / equivalent projection), not as an independently authored authority
taxonomy. Every reason code SHALL map to exactly one durable class or to the existing protocol
`workflow-engine-defect` failure path for unknown codes. Recovery policy compilation, per-item
`blocked_theme`, and recovery budget maps SHALL key only members of that closed durable set.

#### Scenario: Every reason code has a durable class

- **WHEN** the projection is evaluated for each closed stage-diagnostic reason code
- **THEN** it SHALL return exactly one `DurableBlockerClass`
- **AND** the recovery policy SHALL contain a compiled entry for that class

#### Scenario: Orphan budget keys are rejected

- **WHEN** a recovery budget map or policy document names a class outside the closed
  `DurableBlockerClass` set projected from the canonical vocabulary
- **THEN** validation or compilation SHALL fail closed
- **AND** the run SHALL NOT start with a parallel unofficial taxonomy key

#### Scenario: Loop recovery budgets consume the same enum

- **WHEN** the durable loop supervisor charges or consults per-class recovery budgets
- **THEN** the budget key SHALL be a `DurableBlockerClass` member projected from the item's
  canonical diagnostic reason
- **AND** SHALL NOT use a separate ad-hoc string taxonomy parallel to stage diagnostics
)

