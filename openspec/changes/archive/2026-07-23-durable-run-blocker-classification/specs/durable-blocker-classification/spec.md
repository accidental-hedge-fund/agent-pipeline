## ADDED Requirements

### Requirement: The engine SHALL classify every durable-run blocker into a closed typed set

The engine SHALL define a `DurableBlockerClass` string enum in the durable loop module covering
every structurally distinct durable-run failure class, comprising exactly: `transient-rate-limit`,
`workflow-state`, `implementation-ci`, `environment-auth`, `specification-decision`,
`missing-authority`, `upstream-dependency`, and `workflow-engine-defect`. Every durable-run
transition into the `blocked` state SHALL carry exactly one member of this enum, and the recorded
blocked theme SHALL be that member's name so a block's typed class is its budget key. A block that
supplies no class, or a value outside the enum, SHALL be refused as a validation failure that
leaves durable state unchanged. Only an item currently `in_progress` SHALL be eligible to
transition into `blocked` — an item already `blocked` SHALL be refused a second blocking
transition as a validation failure, so a duplicate or retried block report on an item nothing has
attempted to recover can never be counted as repeated no-progress; reaching `blocked` again for the
same item requires an intervening successful recovery back to `in_progress`.

#### Scenario: A blocked transition carries a valid class

- **WHEN** an item transitions into `blocked` with class `implementation-ci`
- **THEN** the transition SHALL be accepted
- **AND** the item's recorded blocked theme SHALL be `implementation-ci`

#### Scenario: A duplicate block report on an already-blocked item is refused

- **WHEN** an item that is already `blocked` is given another blocking transition without an
  intervening successful recovery back to `in_progress`
- **THEN** it SHALL be refused as a validation failure
- **AND** the item's repeated-evidence count SHALL NOT be incremented

#### Scenario: A blocked transition without a class is refused

- **WHEN** an item transitions into `blocked` with no blocker class supplied
- **THEN** it SHALL be refused as a validation failure
- **AND** the item's state SHALL be unchanged

#### Scenario: An out-of-enum class is refused

- **WHEN** an item transitions into `blocked` with a class value not in `DurableBlockerClass`
- **THEN** it SHALL be refused as a validation failure naming the offending value
- **AND** durable state SHALL be unchanged

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

The engine SHALL fail closed when a blocker cannot be resolved to exactly one
`DurableBlockerClass` — because no class matches or more than one matches — by recording a terminal
needs-human stop naming the item and the ambiguity, emitting a stop event, and refusing the
transition with a stop-class failure. It SHALL NOT select a recovery recipe, SHALL NOT decrement
any recovery budget, and SHALL NOT guess a class.

#### Scenario: An unmatched blocker stops the run for human review

- **WHEN** a blocker matches no `DurableBlockerClass`
- **THEN** the run SHALL be recorded as stopped for a needs-human classification failure naming
  the item
- **AND** no recovery budget SHALL be decremented

#### Scenario: An ambiguous blocker does not silently retry

- **WHEN** a blocker matches more than one class
- **THEN** the run SHALL fail closed with a stop-class failure naming the ambiguity
- **AND** no recovery recipe SHALL be attempted

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
the blocker class, the attempted recovery actions, the evidence fingerprint, and the outcome
(recovered, exhausted, repeated-no-progress, needs-human, human-authority, or failed). The engine
SHALL determine the outcome from the actual result of the attempted actions — reported explicitly
by the caller that executed them — and SHALL NOT record `recovered` for actions that did not
succeed. The engine SHALL emit a Pipeline-native event for each such attempt. Persistence SHALL
survive process restart via the durable store so a resuming engine reads the same history.

#### Scenario: A recovery attempt is recorded and emitted

- **WHEN** a recovery attempt completes for a blocked item
- **THEN** the ledger SHALL carry a record naming the item, class, attempted actions, evidence
  fingerprint, and outcome
- **AND** a Pipeline-native event SHALL be emitted for that attempt

#### Scenario: A failed recovery action is recorded as failed, not recovered

- **WHEN** the recovery actions attempted for a blocked item did not succeed
- **THEN** the ledger SHALL record the attempt's outcome as `failed`
- **AND** the item SHALL remain `blocked`
- **AND** no recovery budget SHALL be charged for that attempt

#### Scenario: Recovery history survives restart

- **WHEN** a new engine process resumes the run after recovery attempts were recorded
- **THEN** it SHALL read the same per-attempt classification, actions, evidence, and outcomes from
  the durable store

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

When an item is blocked, the engine SHALL allow a dependency-independent eligible item to continue
only when the blocking class's policy marks the block non-run-fatal. When the blocking class's
policy is run-fatal, the engine SHALL record the terminal stop at the moment of the blocking
transition itself and SHALL NOT start any further item, and SHALL NOT permit the blocked item to
recover automatically — a run-fatal class's whole point is that the run cannot safely continue
without a human, so recovery is refused the same way it is for every other terminal stop.
Independent-item continuation SHALL respect the existing single-active-item and merge-barrier
invariants.

#### Scenario: A non-run-fatal block lets an independent item proceed

- **WHEN** an item is blocked under a class whose policy is non-run-fatal and an eligible item with
  no dependency on the blocked item exists
- **THEN** the engine SHALL permit that independent item to be started
- **AND** the single-active-item and merge-barrier invariants SHALL still hold

#### Scenario: A run-fatal block stops the whole run

- **WHEN** an item is blocked under a class whose policy is run-fatal
- **THEN** the run SHALL be recorded as stopped at that same blocking transition
- **AND** no further item SHALL be started
- **AND** a recovery attempt on the blocked item itself SHALL also be refused with a stop-class
  failure
