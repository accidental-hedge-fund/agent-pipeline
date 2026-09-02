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

### Requirement: Permitted recovery recipes SHALL never cross an authority gate

No recovery recipe permitted by the policy SHALL perform a merge, release, credential, or deploy action, and no recipe SHALL widen an authority grant the contract does not hold. The `missing-authority` class SHALL map to a terminal human-authority outcome only for a current protected `AuthorityRequest`. The `specification-decision` class SHALL map to a terminal human-authority outcome only for an irreducible `DecisionRequest` after the shared classifier. Pipeline SHALL NOT assign either class until that classifier has run. Missing information and unavailable capability SHALL NOT use these classes. This reinforces, and never bypasses, the engine's existing authority gates. Auto-settle SHALL NOT become a block of either class.

#### Scenario: No recipe performs a gated action

- **WHEN** the permitted recovery recipes for every class are inspected
- **THEN** none SHALL include a merge, release, credential, or deploy action

#### Scenario: Missing-authority routes to a human, not a retry

- **WHEN** an item blocks with class `missing-authority` after the classifier emits a protected `AuthorityRequest`
- **THEN** the policy outcome SHALL be a terminal human-authority stop
- **AND** no automated recovery recipe SHALL be attempted

#### Scenario: Specification-decision routes to a human, not a retry

- **WHEN** an item blocks with class `specification-decision` after the classifier emits an irreducible `DecisionRequest`
- **THEN** the policy outcome SHALL be a terminal human-authority stop for a product decision
- **AND** no automated recovery recipe SHALL be attempted

#### Scenario: Reversible choice is not specification-decision

- **WHEN** the classifier auto-settles a reversible in-scope recommendation
- **THEN** Pipeline SHALL NOT record `specification-decision` or `missing-authority`
- **AND** SHALL NOT start a human-authority stop

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

### Requirement: Harness entitlement and ordinary throttle SHALL project to typed durable classes

When a durable-run item blocks because a harness invoke failed with **ordinary transient rate limiting / throttling**, the stage diagnostic projection SHALL resolve to `transient-rate-limit` (for example via the existing `transient-infra` reason code). When a durable-run item blocks because a harness invoke failed with a **model entitlement / usage-credit refusal** (including the Fable-requires-usage-credits class after auto fallback is exhausted or when the model was explicit), the projection SHALL resolve to `environment-auth` via a distinct canonical reason code (`model-entitlement-required` or `capability-refusal`) so metrics can separate account entitlement from credential auth failures. Neither ordinary throttle nor entitlement refusal SHALL project to `workflow-engine-defect` solely because the harness reported zero input/output tokens, a short duration, `throttled: true` on accounting, or non-JSON / non-verdict stdout that is the entitlement message itself.

Unknown diagnostics that match no known reason code SHALL continue to fail closed as `workflow-engine-defect` per the existing unknown-blocker requirement; this requirement only constrains the two known harness failure classes above.

#### Scenario: Ordinary throttle projects to transient-rate-limit

- **WHEN** a stage diagnostic carries ordinary rate-limit / throttle evidence without entitlement-specific usage-credit text
- **THEN** projection SHALL yield blocker class `transient-rate-limit`
- **AND** it SHALL NOT yield `workflow-engine-defect` for that diagnostic

#### Scenario: Entitlement refusal projects to environment-auth

- **WHEN** a stage diagnostic carries Fable/usage-credit entitlement refusal after auto fallback exhaustion or for an explicit model
- **THEN** projection SHALL yield blocker class `environment-auth`
- **AND** the reason code SHALL be distinct from a generic missing credential when the failure is entitlement/capability
- **AND** it SHALL NOT yield `workflow-engine-defect` for that diagnostic

#### Scenario: Zero-token entitlement message is not an unmatched engine defect by default

- **WHEN** a reviewer harness returns the usage-credit entitlement text with zero tokens and the diagnostic is emitted with the entitlement reason code
- **THEN** durable classification SHALL follow the entitlement projection above
- **AND** recovery policy selection SHALL use the `environment-auth` budget and recipes, not the `workflow-engine-defect` budget

### Requirement: Dead-holder interrupt SHALL NOT be workflow-engine-defect

The engine SHALL classify a mid-stage kill, crash, SIGTERM, host reboot, or network drop as a resume-eligible interrupt when the prior holder is dead. That classification SHALL NOT be `workflow-engine-defect`. The classifier SHALL use process-liveness and lock/wrapper identity, not the presence of a leftover harness-failure string or a leftover loop run directory. A genuine engine defect that occurs while a holder is still live, or a repeated same-fingerprint crash after a successful resume attempt has already run, MAY remain `workflow-engine-defect` under existing policy.

#### Scenario: SIGTERM mid-implement is an interrupt

- **WHEN** an implementer is killed by SIGTERM
- **AND** the recorded holder PID is dead
- **AND** no live wrapper identity exists for that issue
- **THEN** the durable class SHALL NOT be `workflow-engine-defect`
- **AND** recovery SHALL treat the item as resume-eligible

#### Scenario: Leftover harness-failure text does not force the defect class

- **WHEN** a prior loop outcome is `failed` with `harness-failure`
- **AND** a later observe finds the holder dead and the same item still `pipeline:implementing`
- **THEN** the classifier SHALL NOT keep `workflow-engine-defect` as the current class solely because of that leftover harness-failure text
- **AND** the item SHALL remain resume-eligible

#### Scenario: Live crashed holder may still be an engine defect

- **WHEN** a dispatch crashes
- **AND** a live lock or live wrapper identity still exists for the item
- **THEN** existing `workflow-engine-defect` policy MAY apply
- **AND** this requirement SHALL NOT reclassify that live holder as an interrupt

#### Scenario: Second independent dead-holder interrupt is still resume-eligible

- **WHEN** issue N has already recovered from one dead-holder interrupt
- **AND** a later observe finds a different dead holder or a different crash identity for the same item
- **THEN** the durable class SHALL NOT be `workflow-engine-defect` solely because a prior takeover exists
- **AND** recovery SHALL treat the item as resume-eligible again

### Requirement: Missing information SHALL NOT project as specification-decision

Pipeline SHALL project missing information and `human-context-required` as a `CapabilityRequest` or an external-condition wait. That projection SHALL NOT use durable class `specification-decision` or `missing-authority`. Product decisions and protected authority SHALL remain distinct after the shared classifier.

#### Scenario: Human-context-required is not specification-decision

- **WHEN** a diagnostic reason is `human-context-required` and the missing data is information or context
- **THEN** projection SHALL NOT yield `specification-decision`
- **AND** SHALL NOT yield `missing-authority`

#### Scenario: Capability gap is not missing-authority

- **WHEN** the classifier emits a `CapabilityRequest` for an unavailable credential
- **THEN** the durable class SHALL NOT be `missing-authority`
- **AND** SHALL NOT be `specification-decision`
