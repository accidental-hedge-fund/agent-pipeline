# operation-reliability Specification

## Purpose
Defines the Logical Operation identity, closed terminal-outcome set, unique-operation reliability report, and integrity rules that make retries, restarts, and nested child work count as one admitted operation.

## Requirements

### Requirement: Public-command admission SHALL mint one opaque immutable logical_operation_id

The pipeline SHALL mint a `logical_operation_id` at admission of numeric drive, `single`, `loop`, `train`, `merge`, merge queue, and `ship`. The identifier SHALL be opaque and immutable for that admission. The pipeline SHALL retain the same identifier across retry, restart, reattachment, nested child work, train waves, ship phases, and attestation ticks. `run_id` SHALL remain the physical execution identity and SHALL NOT be used as the unique-operation denominator. A new external admission SHALL receive a new `logical_operation_id` unless it presents a valid resume binding.

#### Scenario: Fresh public admission mints a logical identity

- **WHEN** an operator admits `pipeline single 42` with no resume binding
- **THEN** the run SHALL persist a non-empty `logical_operation_id`
- **AND** SHALL persist a distinct `run_id`

#### Scenario: Retry keeps the same logical identity

- **WHEN** the same admitted operation retries or a fresh process resumes it through a valid resume binding
- **THEN** the new physical `run_id` MAY differ
- **AND** `logical_operation_id` SHALL equal the original admission identity
- **AND** the retry SHALL NOT count as a second successful unique operation

#### Scenario: New external admission without binding is a new operation

- **WHEN** an operator starts a new public command for unfinished work without a valid resume binding
- **THEN** the pipeline SHALL mint a new `logical_operation_id`
- **AND** that admission SHALL be Manual reinvocation relative to the unfinished operation

---

### Requirement: Nested child runs SHALL inherit the parent logical_operation_id

Nested child work spawned by an admitted parent (train → loop, ship → pack loop, parent-spawned `single`) SHALL copy the parent's `logical_operation_id` through the existing parent handoff. Nested child runs SHALL NOT mint a second logical identity. Retraining waves, ship phases, and attestation ticks for that parent SHALL keep the same identity.

#### Scenario: Train child loop inherits the train identity

- **WHEN** an admitted `pipeline train` starts a nested loop run
- **THEN** the child loop run SHALL carry the train's `logical_operation_id`
- **AND** SHALL NOT mint a distinct logical identity

#### Scenario: Attestation tick is not a new operation

- **WHEN** a ship or FRG attestation tick records evidence for an already admitted operation
- **THEN** that tick SHALL keep the original `logical_operation_id`
- **AND** SHALL NOT increment unique-operation success counts by itself

---

### Requirement: Valid resume binding SHALL be explicit durable identity, never a guess

A resume binding SHALL be one of: re-entry of an existing run directory that already stores `logical_operation_id`; a durable loop-store run whose contract already stores that id; a parent handoff that names the parent `logical_operation_id`; or an operator resume of a named `run_id` that already stores that id. The pipeline SHALL NOT invent a logical identity from issue number, latest run, PATH candidate, or comment prose.

#### Scenario: Same run directory re-entry reuses the written id

- **WHEN** a process re-enters a run directory whose `run.json` already contains `logical_operation_id` `L`
- **THEN** the resumed execution SHALL use `L`
- **AND** SHALL NOT overwrite that field

#### Scenario: Latest-run lookup is not a resume binding

- **WHEN** a new public admission has no named run, loop-store id, or parent handoff
- **AND** a later run for the same issue exists on disk
- **THEN** the pipeline SHALL mint a new `logical_operation_id`
- **AND** SHALL NOT copy the later run's identity by recency

---

### Requirement: Verified completion SHALL require exact-candidate postcondition proof

Verified completion SHALL be authoritative proof that the exact-candidate postcondition of the Logical Operation is satisfied. Process termination, a `run_complete` event, a zero exit code, and GitHub issue closure SHALL NOT by themselves constitute verified completion. Reliability success numerators SHALL count a logical operation at most once.

#### Scenario: Zero exit without postcondition proof is not success

- **WHEN** a physical run exits 0 and emits `run_complete`
- **AND** exact-candidate postcondition proof is absent
- **THEN** the operation SHALL NOT be counted as verified success

#### Scenario: Reconciled completed side effect counts once on the original operation

- **WHEN** a later process proves that a side effect already completed for logical operation `L`
- **THEN** that proof SHALL contribute one completion to `L`
- **AND** SHALL NOT mint a new successful unique operation
- **AND** SHALL NOT replay the completed side effect

---

### Requirement: Every admitted supervised operation SHALL end in a closed terminal-outcome set

Every admitted supervised operation SHALL end as exactly one of: verified success; durable cooling or recovery; external-condition wait; typed decision, capability, or authority request; or explicit authenticated operator cancellation. An admitted operation whose process or strategy ends in none of those states SHALL be an Ownerless terminal. Mechanical, workflow, infrastructure, authentication, or unknown failure projected as human ownership without a genuine matching condition SHALL be a False-human projection.

#### Scenario: Mechanical fault remains owned

- **WHEN** a mechanical fault occurs on an admitted operation
- **THEN** the operation SHALL remain in durable cooling or recovery, an external-condition wait, or a valid typed request
- **AND** SHALL NOT become an Ownerless terminal
- **AND** SHALL NOT become a False-human projection

#### Scenario: Later verified proof does not erase an unresolved ownerless terminal

- **WHEN** a logical operation has a physical attempt that ends ownerless
- **AND** no durable cooling, recovery, external wait, typed request, or cancellation links that attempt
- **AND** a later physical attempt records verified completion
- **THEN** ownerless-terminal count SHALL be greater than zero
- **AND** the operation SHALL NOT be scored as clean unique-operation success from that later proof alone

#### Scenario: Legitimate typed request is not a false-human projection

- **WHEN** a genuine Decision Request, Capability Request, or Authority Request is recorded with a matching condition
- **THEN** the outcome SHALL be that typed request
- **AND** SHALL NOT be counted as a False-human projection

---

### Requirement: Unique-operation reliability denominators SHALL deduplicate by logical_operation_id

All unique-operation reliability rates SHALL use distinct `logical_operation_id` values as the denominator. Retries, restarts, train waves, ship phases, attestation ticks, and raw run counts SHALL NOT be substituted for that denominator. Closed-issue count SHALL NOT be the success-rate denominator. Reports SHALL expose numerators, denominators, stable exclusions, missing-correlation counts, and per-operation evidence references.

#### Scenario: Two physical runs of one logical operation count once

- **WHEN** logical operation `L` has two physical `run_id` values and later reaches verified completion
- **THEN** the unique-operation success numerator SHALL increase by 1
- **AND** the unique-operation denominator SHALL include `L` once

#### Scenario: Missing correlation is an integrity failure

- **WHEN** an admitted supervised run has no `logical_operation_id` or has contradictory parent/child identities
- **THEN** the report SHALL increment a missing-correlation or contradictory-correlation integrity count
- **AND** SHALL NOT exclude that run from the unique-operation contract as if it were a declared expected wait

---

### Requirement: Unique-operation SLOs SHALL be exact numeric targets

Required clean operations SHALL reach verified completion without Manual reinvocation at 100%. False-human projection count SHALL be 0. Ownerless terminal count SHALL be 0. Applicable Exact-candidate recovery SHALL pass at 100%. Applicable Independent-sibling continuation SHALL pass at 100%. A typed request, external wait, or cancellation SHALL be excluded from clean completion only when the versioned pack manifest declares that expected outcome, and it SHALL remain separately counted and contract-validated.

#### Scenario: Manual reinvocation fails clean completion

- **WHEN** a required clean operation reaches verified completion only after a new external admission without a valid resume binding
- **THEN** clean-completion without Manual reinvocation SHALL fail
- **AND** the original logical operation SHALL not be scored as a clean unique success

#### Scenario: Manifest-declared wait is a stable exclusion

- **WHEN** the versioned pack manifest declares an external-condition wait as the expected outcome for fixture `F`
- **AND** fixture `F` ends in that wait with a live probe
- **THEN** `F` SHALL be excluded from the clean-completion denominator
- **AND** SHALL still be counted and contract-validated as that expected wait

#### Scenario: Missing coverage is never an exclusion

- **WHEN** a required public entry point has no correlated evidence
- **THEN** the integrity count for missing required coverage SHALL increase
- **AND** that gap SHALL NOT be recorded as a stable exclusion
