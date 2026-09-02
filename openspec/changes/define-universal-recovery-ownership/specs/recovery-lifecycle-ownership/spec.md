## Purpose

Defines the closed lifecycle states and ownership law so a supervised operation stays owned until verified success, durable recovery or Cooling, an external-condition or typed-input wait, or explicit cancellation, and so failure never grants human authority.

## ADDED Requirements

### Requirement: Supervised operations SHALL use a closed lifecycle state set

RecoverySupervisor SHALL record exactly one current lifecycle state for every admitted Logical Operation: `active`, `cooling`, `external-condition-wait`, `typed-input-wait`, `succeeded`, or `cancelled`. No other lifecycle state SHALL exist. Compatibility labels, comments, events, process exit codes, and `ledger.stop.reason` values SHALL project from that state and SHALL NOT be lifecycle truth.

`active` SHALL mean the operation is executing an adapter attempt or a claimed recovery treatment. `cooling` SHALL mean the operation is owned and waiting for the next eligible observation or wake. `external-condition-wait` SHALL mean the operation is owned and waiting on a named external condition with a live probe and a time- or event-based wake rule. `typed-input-wait` SHALL mean a current `DecisionRequest`, `CapabilityRequest`, or `AuthorityRequest` is outstanding. `succeeded` SHALL mean the declared observer has proven the exact-candidate postcondition. `cancelled` SHALL mean an authenticated operator or the original authorized caller cancelled the operation.

#### Scenario: Closed set is exhaustive

- **WHEN** a Logical Operation is admitted
- **THEN** RecoverySupervisor SHALL assign exactly one of `active`, `cooling`, `external-condition-wait`, `typed-input-wait`, `succeeded`, or `cancelled`
- **AND** SHALL NOT invent a seventh lifecycle state

#### Scenario: Compatibility label is not lifecycle state

- **WHEN** an issue carries `pipeline:needs-human` or `pipeline:blocked`
- **THEN** that label SHALL NOT by itself be the lifecycle state
- **AND** RecoverySupervisor SHALL derive lifecycle state from durable ownership records and current typed-request evidence

---

### Requirement: A supervised operation SHALL remain owned until a lawful exit

A supervised operation SHALL remain owned until verified success, durable Cooling or recovery, an external-condition wait, a current typed-input wait, or explicit cancellation by an authenticated operator or the original authorized caller. Mechanical failure, unknown failure, malformed output, process death, no progress, capacity, retry exhaustion, and controller failure SHALL NOT end ownership. Those faults SHALL NOT synthesize cancellation or human ownership.

#### Scenario: Mechanical failure stays owned

- **WHEN** a supervised adapter throws, exits non-zero, times out, or dies after admission
- **THEN** RecoverySupervisor SHALL retain ownership as `active` or `cooling`
- **AND** SHALL NOT mark the Logical Operation `succeeded` or `cancelled`
- **AND** SHALL NOT enter `typed-input-wait` solely for that fault

#### Scenario: Retry exhaustion stays Cooling

- **WHEN** a strategy cursor or recovery budget is exhausted for a mechanical class
- **THEN** the operation SHALL enter `cooling` or `external-condition-wait`
- **AND** SHALL NOT become `cancelled`
- **AND** SHALL NOT become `typed-input-wait`

#### Scenario: Process death is not cancellation

- **WHEN** the host process dies while a Logical Operation is `active`
- **THEN** a later RecoverySupervisor SHALL resume the same Logical Operation as `cooling` or `active`
- **AND** SHALL NOT treat the death as `cancelled` or `succeeded`

---

### Requirement: Failure SHALL NOT grant human authority

Mechanical failure, unknown failure, malformed output, process death, no progress, capacity, retry exhaustion, controller failure, stale labels, and low model confidence SHALL NOT create a `DecisionRequest`, a `CapabilityRequest`, an `AuthorityRequest`, or any human-ownership disposition. A raw failure SHALL be none of those request types. Human authority SHALL require a current typed request produced by the shared classifier in `typed-request-resolution`.

#### Scenario: Unknown error is not a typed request

- **WHEN** an adapter reports an unrecognized error shape and no current typed-request evidence exists
- **THEN** RecoverySupervisor SHALL keep the operation in `cooling` or `external-condition-wait`
- **AND** SHALL NOT emit a `DecisionRequest`, `CapabilityRequest`, or `AuthorityRequest`

#### Scenario: Capacity is not human ownership

- **WHEN** worktree or run capacity is exhausted
- **THEN** the operation SHALL remain owned as `cooling` or `external-condition-wait`
- **AND** SHALL NOT project `pipeline:needs-human` as human authority solely for that capacity

#### Scenario: Malformed output is not a DecisionRequest

- **WHEN** a harness returns malformed JSON or missing required sections
- **THEN** RecoverySupervisor SHALL treat the outcome as engine-owned recovery
- **AND** SHALL NOT create a `DecisionRequest` or human hold solely for that shape failure

---

### Requirement: Typed requests SHALL be structurally distinct owned waits

`DecisionRequest`, `CapabilityRequest`, and `AuthorityRequest` SHALL remain the only public typed-request types. Each SHALL enter `typed-input-wait` and SHALL keep the Logical Operation owned. A `DecisionRequest` SHALL select among permitted product alternatives and SHALL carry a recommendation. A reversible in-scope authorized default MAY auto-settle and SHALL NOT enter `typed-input-wait`. A `CapabilityRequest` SHALL report unavailable capability, condition, or required information and SHALL ask for restoration or input, not approval. An `AuthorityRequest` SHALL ask for protected authority Pipeline does not possess, SHALL bind eligible actor, repository, operation, scope, candidate epoch, evidence, and expiry, and SHALL NOT record a default grant. Candidate movement SHALL invalidate candidate-bound requests and grants.

#### Scenario: DecisionRequest is not authority

- **WHEN** the shared classifier emits an irreducible product choice
- **THEN** RecoverySupervisor SHALL enter `typed-input-wait` with a `DecisionRequest`
- **AND** SHALL NOT treat that request as an `AuthorityRequest`

#### Scenario: Reversible recommendation auto-settles

- **WHEN** the classifier records a reversible in-scope authorized recommendation
- **THEN** Pipeline SHALL auto-settle that recommendation
- **AND** SHALL NOT enter `typed-input-wait`

#### Scenario: CapabilityRequest is not approval

- **WHEN** progress requires an unavailable credential with a live probe
- **THEN** RecoverySupervisor SHALL enter `typed-input-wait` with a `CapabilityRequest`
- **AND** SHALL NOT request merge, release, deploy, or override authority

#### Scenario: AuthorityRequest never defaults

- **WHEN** a recommendation requires merge authority that trusted facts do not prove
- **THEN** RecoverySupervisor SHALL enter `typed-input-wait` with an `AuthorityRequest`
- **AND** SHALL leave the grant unset
- **AND** SHALL bind the request to the current candidate epoch

#### Scenario: Raw failure is not a typed request

- **WHEN** a merge adapter fails with a timeout and no classifier evidence exists
- **THEN** RecoverySupervisor SHALL NOT emit any of the three request types
- **AND** SHALL keep the operation in `cooling` or `external-condition-wait`

---

### Requirement: Verified success SHALL require authoritative observer evidence

Verified completion SHALL require the declared owning-system observer to prove the postcondition for the bound candidate and side-effect identity. Git facts SHALL come from git. Forge state, checks, and reviews SHALL come from the forge. Merge containment SHALL come from the fetched base. Release and deploy facts SHALL come from their owning systems. Orchestration state SHALL come from the durable RecoverySupervisor records, not from a process exit or a comment. A process exit, exception, timeout, model response, or `run_complete` event SHALL be ingress evidence and SHALL NOT by itself mark `succeeded`.

#### Scenario: Exit zero is not succeeded

- **WHEN** a supervised process exits 0
- **AND** the observer has not proven the postcondition
- **THEN** the lifecycle state SHALL NOT be `succeeded`

#### Scenario: Forge merge is the merge authority

- **WHEN** the forge observer proves the linked PR merged and contained in the fetched base
- **THEN** reconciliation SHALL treat that merge as proven
- **AND** a local ledger that still says mid-flight SHALL NOT overrule the forge

#### Scenario: Orchestration state is supervisor-owned

- **WHEN** a host reports `run_complete` with `final_state: error`
- **THEN** that event SHALL NOT by itself cancel or succeed the Logical Operation
- **AND** RecoverySupervisor SHALL retain ownership until an observer-backed exit applies

---

### Requirement: Every mutating OPERATION_SURFACE verb SHALL have a classified disposition

Every mutating `OPERATION_SURFACE` verb SHALL have at least one command-form inventory row whose `execution_disposition` is `supervised-lifecycle` or `bounded-atomic-administration`. Read-only documented forms SHALL be `read-only`. Typed-answer and authority operations SHALL use the existing `authority_requirement` axis (`typed-response` or `protected-authority`) and SHALL NOT be a fourth execution disposition. No lifecycle-affecting mutation SHALL remain an undocumented carve-out. The pipeline SHALL reuse `COMMAND_FORM_INVENTORY` and SHALL NOT add a second inventory.

#### Scenario: Host catalog verb is classified

- **WHEN** `OPERATION_SURFACE` lists a mutating verb
- **THEN** the command-form inventory SHALL contain a form for that verb
- **AND** a missing form SHALL fail the existing inventory contract test

#### Scenario: Authority is a second axis

- **WHEN** `pipeline merge` is inspected
- **THEN** its execution disposition SHALL be `supervised-lifecycle`
- **AND** its authority requirement SHALL be `protected-authority`

#### Scenario: Dry-run is not supervised by inheritance

- **WHEN** a documented `--dry-run` form exists
- **THEN** that form SHALL be `read-only`
- **AND** SHALL NOT inherit `supervised-lifecycle` from the drive form

---

### Requirement: Explicit cancellation SHALL require authenticated caller authority

A Logical Operation SHALL enter `cancelled` only when an authenticated operator or the original authorized caller issues an explicit cancel. Mechanical failure, retry exhaustion, process death, unknown failure, and a model-authored default SHALL NOT synthesize `cancelled`. Cancel SHALL leave an audited record naming the actor, the Logical Operation, and the time.

#### Scenario: Operator cancel is lawful

- **WHEN** an authenticated operator cancels a current Logical Operation
- **THEN** RecoverySupervisor SHALL record `cancelled`
- **AND** SHALL retain the audit record

#### Scenario: Exhaustion is not cancel

- **WHEN** recovery retry budget reaches zero
- **THEN** RecoverySupervisor SHALL NOT record `cancelled`
- **AND** SHALL enter `cooling`

---

### Requirement: Process stop SHALL NOT end lifecycle ownership

A process exit, invocation cap, host STOP, or `run_complete` event MAY end the current process. That process stop SHALL NOT by itself mark the Logical Operation `succeeded` or `cancelled`. Independent siblings that do not transitively depend on a waiting or cooling peer SHALL continue. `STOP` SHALL remain a compatibility train outcome meaning no selected item can progress in the current pass.

#### Scenario: MAX_ITERATIONS stop stays owned

- **WHEN** an advance invocation exhausts `MAX_ITERATIONS` at a non-ready-to-deploy stage
- **THEN** the process MAY exit non-zero as an incomplete invocation
- **AND** RecoverySupervisor SHALL retain ownership as `cooling`
- **AND** SHALL NOT enter `typed-input-wait` solely for that cap

#### Scenario: Train STOP is not cancellation

- **WHEN** train reports compatibility `STOP` because every selected item is cooling or waiting
- **THEN** underlying operations SHALL remain owned
- **AND** independent ready-to-deploy siblings MAY still merge under existing merge authority
- **AND** no item SHALL become `cancelled` solely for that STOP

---

### Requirement: Legacy terminals SHALL migrate onto the closed lifecycle states

The engine SHALL treat the following historical outcomes as compatibility projections of the closed lifecycle states and SHALL NOT treat them as lifecycle terminals or human ownership for mechanical, unknown, malformed, process-death, no-progress, capacity, or retry-exhaustion faults:

| Legacy outcome | Lifecycle treatment |
| --- | --- |
| `run_fatal` | `cooling` or `external-condition-wait`. Historical `ledger.stop.reason = run_fatal` MAY remain as a compatibility projection. Live first record SHALL NOT end ownership or grant human authority. |
| `recovery_exhausted` | `cooling`. Historical evidence MAY remain. Live first record SHALL NOT be a terminal run stop. |
| `repeated_no_progress` | `cooling` or the next owned treatment. SHALL NOT refuse all siblings or grant human authority. |
| Cycle caps (`MAX_ITERATIONS`, auto-loop round and wall-clock budgets, recovery class budgets) | Process-invocation stop and/or `cooling`. SHALL NOT park as human-owned `needs-human`. |
| `blocked` | Compatibility label. Reclassify through durable lifecycle state. Never scheduler or authority truth by itself. |
| `needs-human` | Compatibility projection of a current `typed-input-wait`. The label alone is not authority. Mechanical exhaustion SHALL NOT apply this label as human ownership. |

Operator `--resume` of a historical `run_fatal` or `recovery_exhausted` record SHALL remain the wake for that compatibility projection. Resume SHALL NOT be required to re-create ownership that Cooling already retained.

#### Scenario: Live run_fatal is Cooling

- **WHEN** a live supervisor first records a `run_fatal` class for a mechanical or controller fault
- **THEN** the Logical Operation SHALL enter `cooling`
- **AND** SHALL NOT become ownerless
- **AND** SHALL NOT enter `typed-input-wait`

#### Scenario: recovery_exhausted is Cooling

- **WHEN** a strategy cursor is exhausted
- **THEN** the item SHALL remain in `cooling` or `external-condition-wait`
- **AND** historical `recovery_exhausted` evidence MAY remain
- **AND** independent siblings SHALL continue

#### Scenario: repeated_no_progress does not kill the run

- **WHEN** consecutive identical evidence reaches the configured limit
- **THEN** that item SHALL enter `cooling`
- **AND** RecoverySupervisor SHALL NOT refuse independent sibling transitions solely for that limit

#### Scenario: Auto-loop budget exhaustion is not human-owned

- **WHEN** `auto_loop.max_rounds` or `max_wallclock_minutes` is exhausted
- **THEN** the operation SHALL enter `cooling`
- **AND** SHALL NOT transition to human-owned `pipeline:needs-human` solely for that budget

#### Scenario: blocked label is not lifecycle

- **WHEN** an issue carries `pipeline:blocked` without current typed-request evidence
- **THEN** RecoverySupervisor SHALL reclassify through durable lifecycle state
- **AND** SHALL NOT treat the label as `typed-input-wait`

#### Scenario: needs-human without typed request is false-human

- **WHEN** an issue carries `pipeline:needs-human` and no current DecisionRequest, CapabilityRequest, or AuthorityRequest exists
- **THEN** RecoverySupervisor SHALL NOT treat that label as human authority
- **AND** SHALL recover the item as engine-owned `cooling` or another owned treatment

---

### Requirement: The next identical false-human fault SHALL not require a new mole issue

Grill, advance, recovery, train, ship, and every supervised command form SHALL classify lifecycle exits through RecoverySupervisor and the shared typed-request classifier. A production site SHALL NOT park `needs-human`, emit `human_intervention` as authority, or record `cancelled` for a mechanical class without those shared paths. A unit or static guard SHALL fail when a production site bypasses that law.

#### Scenario: Site cannot park mechanical exhaustion as human

- **WHEN** a production site attempts to set `pipeline:needs-human` for retry exhaustion without classifier evidence
- **THEN** a unit or static guard SHALL fail
- **AND** RecoverySupervisor SHALL keep the item in `cooling`

#### Scenario: Next identical controller fault uses this law

- **WHEN** a later supervised command hits unknown failure after admission
- **THEN** that command SHALL report an operation observation to RecoverySupervisor
- **AND** SHALL NOT require a new path-local issue to avoid human ownership
