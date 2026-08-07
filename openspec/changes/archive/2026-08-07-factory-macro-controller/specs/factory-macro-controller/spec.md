## ADDED Requirements

### Requirement: The factory macro-controller SHALL be disabled by default and inert when disabled

Agent Pipeline SHALL provide a factory macro-controller that is **disabled by default**. When the controller is disabled, interactive single-issue advance (`pipeline` / `single`), durable multi-item `loop`, operator `merge`, and operator `release` surfaces SHALL retain their pre-existing behavior for the same inputs: they SHALL NOT require factory enablement flags, SHALL NOT create factory-run state as a side effect of those ordinary commands, and SHALL NOT route scheduling authority through the macro-controller.

#### Scenario: Default install does not activate the macro-controller

- **WHEN** an operator runs ordinary `pipeline <N>`, `pipeline loop`, `pipeline merge`, or `pipeline release` without enabling the factory macro-controller
- **THEN** the command path SHALL complete under the existing advance/loop/merge/release controllers
- **AND** no factory-run directory, factory contract revision, or factory action claim SHALL be required or created as a side effect of that ordinary command

#### Scenario: Enabling is explicit

- **WHEN** an operator wants factory macro-controller ownership of a repository-level factory lifecycle
- **THEN** enablement SHALL require an explicit configuration flag and/or dedicated factory entry surface
- **AND** the default configuration value SHALL leave the controller disabled

---

### Requirement: Agent Pipeline SHALL be the sole authoritative store and scheduler for enabled factory runs

When the factory macro-controller is enabled for a factory run, Agent Pipeline SHALL own exactly one authoritative execution contract (current revision pointer + immutable revision documents), one factory ledger/run namespace, one factory lock, and one coarse-action claim/history log for that run. The controller SHALL NOT treat an outer host session, Hermes (or other external) database, agent chat transcript, or free-form issue comment thread as an authoritative scheduler or store for phase, next action, or contract content.

#### Scenario: Outer host is not a second scheduler

- **WHEN** a factory run is enabled and an outer host launches or ticks the macro-controller
- **THEN** coarse phase and next action SHALL be derived only from Pipeline durable factory state plus freshly observed external truth seams
- **AND** the outer host SHALL NOT supply a competing authoritative work queue or phase pointer that the controller is required to obey over durable state

#### Scenario: External databases are not authoritative

- **WHEN** a Hermes or other external database row, or an agent chat memory, disagrees with the Pipeline factory store about current revision, phase, or claims
- **THEN** the macro-controller SHALL treat the Pipeline factory store (plus live external truth for reconciliation) as authoritative
- **AND** SHALL NOT rewrite the contract to match the external row or chat memory as a silent authority source

---

### Requirement: An accepted execution-contract revision SHALL be immutable, canonically hashed, and complete

The macro-controller SHALL represent factory intent as **execution-contract revisions**. Once a revision is accepted, its body SHALL be immutable (no in-place overwrite of accepted content). Each accepted revision SHALL carry a canonical hash computed over a documented hashed body. The hashed body SHALL include at minimum:

1. repository identity, base branch, and observed base SHA
2. selector, issue and PR identities, milestones, and dependency edges
3. linked durable loop and/or advance run identities
4. service controller identity and the revision number of this contract
5. outer-host identity as a field separate from implementer treatment and reviewer treatment
6. authority-policy fingerprint, engine-pin fingerprint, configuration fingerprint, and treatment fingerprint
7. coarse phase at acceptance (or the phase plan snapshot required by the schema), completion policy, and next action

A replan SHALL create a **new** retained revision that records a live-state reason and the prior revision relationship; it SHALL NOT overwrite the prior accepted body.

#### Scenario: Accepted body cannot be overwritten

- **WHEN** a caller attempts to mutate fields of an already-accepted revision body
- **THEN** the store SHALL refuse the mutation
- **AND** the original body and its canonical hash SHALL remain unchanged

#### Scenario: Replan retains a new revision

- **WHEN** a replan is accepted against the current revision
- **THEN** a new revision document SHALL be written with a new revision number and canonical hash
- **AND** the prior revision body SHALL remain readable
- **AND** the new revision SHALL record a live-state reason for the replan

#### Scenario: Hash covers the minimum identity and fingerprint fields

- **WHEN** two accepted revisions differ in any minimum required field (repository base SHA, selector, linked run id, controller identity, outer-host id, implementer treatment, reviewer treatment, any required fingerprint, phase, completion policy, or next action)
- **THEN** their canonical hashes SHALL differ

#### Scenario: Equivalent bodies hash identically

- **WHEN** two compilations produce byte-equivalent hashed bodies under the documented canonicalization rules
- **THEN** their canonical hashes SHALL be identical regardless of which outer host performed the compilation

---

### Requirement: Control identities SHALL remain distinct and SHALL NOT silently remap

Each accepted execution-contract revision and each coarse-action evidence record SHALL represent the following as **distinct** identity fields when factory mode is enabled:

1. service controller identity
2. outer-host identity
3. implementer treatment identity
4. reviewer treatment identity
5. privileged mutation actor identity

The system SHALL NOT rewrite a non-Claude service controller identity to `codex` (or any other host/adapter id) as a silent default. The system SHALL NOT require outer-host identity to equal implementer or reviewer treatment identity, and SHALL NOT require service controller identity to equal outer-host identity.

#### Scenario: Distinct slots are recorded

- **WHEN** a factory run is adopted with outer host `session-host-a`, implementer treatment `my-ext`, reviewer treatment `codex`, service controller `factory-macro@1`, and privileged mutation actor `operator-session-1`
- **THEN** the accepted revision and subsequent coarse-action evidence SHALL preserve each of those five values in distinct fields
- **AND** none of the five fields SHALL be collapsed into a single engine/host string as the sole recorded identity

#### Scenario: Non-Claude controller is not recorded as Codex

- **WHEN** the service controller identity is not Claude and the outer host is not Codex
- **THEN** durable records SHALL NOT write `codex` into the service controller field as a silent default
- **AND** validators SHALL reject a write that aliases controller identity to an unrelated host id without an explicit audited mapping field (which this change does not provide)

#### Scenario: Missing distinct identity fails closed when factory mode is enabled

- **WHEN** adoption is attempted with factory mode enabled and a required identity slot is missing or empty
- **THEN** adoption SHALL fail as a validation error naming the missing slot
- **AND** no current revision pointer SHALL advance

---

### Requirement: The current controller revision SHALL be monotonic and readable without mutation

The factory store SHALL maintain a single **current revision** pointer per factory run that only advances to a higher revision number (monotonic). Read-only consumers (status, evidence summary, doctor-style probes) SHALL be able to read the current revision number, current coarse phase, and next action **without** performing adopt, replan, claim, or child-start mutations.

#### Scenario: Current revision only moves forward

- **WHEN** the current revision is `N` and a successful replan accepts revision `N+1`
- **THEN** the current pointer SHALL become `N+1`
- **AND** no API SHALL set the current pointer to a value less than `N`

#### Scenario: Status is non-mutating

- **WHEN** a read-only status request is made for a factory run
- **THEN** the response SHALL include the current revision, coarse phase, and next action
- **AND** the contract store, claim log, and child-run links SHALL be unchanged by that status request

---

### Requirement: Adoption and replan SHALL use compare-and-set and fail closed on conflict

Adoption of an initial revision and replan onto a new revision SHALL use compare-and-set against an **expected current revision** (null/absent for first adoption). If the expected revision does not match the durable current pointer, or if freshly observed live identity (repository/base or other schema-required live identity) does not match the identity assumed by the request, the operation SHALL fail without advancing the current pointer and without leaving a partially applied new current contract. Failed CAS attempts SHALL leave prior accepted revisions intact.

#### Scenario: Stale expected revision fails without partial mutation

- **WHEN** two replans race with the same expected revision `N` and the first succeeds to `N+1`
- **THEN** the second replan SHALL fail because expected `N` no longer matches current
- **AND** the current pointer SHALL remain `N+1`
- **AND** no hybrid body combining both replan payloads SHALL become current

#### Scenario: Changed live identity refuses replan

- **WHEN** a replan request expects revision `N` but freshly observed base SHA or repository identity differs from the identity required by the replan precondition
- **THEN** the replan SHALL fail closed
- **AND** the current pointer and accepted revision bodies SHALL remain unchanged

#### Scenario: Successful CAS is atomic from a reader's perspective

- **WHEN** a replan CAS succeeds
- **THEN** a reader SHALL observe either the prior current revision entirely or the new current revision entirely
- **AND** SHALL NOT observe a current pointer that references a missing or half-written revision body

---

### Requirement: Coarse actions SHALL be claimed before side effects and dispatched at most once

Before performing an external side effect for a coarse factory action (including starting or resuming a child loop/advance run), the macro-controller SHALL durably create or transition an action claim keyed by factory run, contract revision, and action identity into a claimed state. Duplicate or concurrent ticks that target the same action identity SHALL observe the existing claim and SHALL NOT dispatch a second concurrent side effect for that action. Claim outcomes SHALL include at least started/claimed, completed, failed, and ambiguous-reconcile states sufficient for restart.

#### Scenario: Duplicate tick does not double-start a child

- **WHEN** two ticks concurrently decide the next action is `start_loop` for the same factory run, revision, and action identity
- **THEN** at most one child loop start SHALL be invoked through the injected child-start seam
- **AND** both ticks SHALL reconcile against the same durable claim identity

#### Scenario: Crash after claim does not grant a free second dispatch

- **WHEN** the process dies after persisting a claim in the claimed/started state but before recording a terminal claim outcome
- **THEN** a restarted controller SHALL resume from that claim and live child observation
- **AND** SHALL NOT create a second unclaimed dispatch for the same action identity

#### Scenario: Crash before claim allows a clean first claim

- **WHEN** the process dies after deriving next action but before persisting any claim
- **THEN** a restarted controller SHALL re-derive from durable state and live truth
- **AND** MAY create the first claim and dispatch exactly once

#### Scenario: Lost or timed-out child-start response reconciles by action id

- **WHEN** a child whole-run start succeeds at the child service but the start response is lost, rejected, or times out before the claim records a child run id
- **THEN** the controller SHALL record the claim in an `ambiguous_reconcile` state for that action identity
- **AND** a subsequent tick SHALL look up any existing child by the durable action id before re-invoking the child-start seam
- **AND** when that lookup returns an existing child run id, the controller SHALL link it on the claim and SHALL NOT create a second child run for the same action identity
- **AND** child-start seams SHALL be durable-idempotent on action id as a second line of defense

---

### Requirement: Restart SHALL reconstruct phase and next action without conversation memory

On every tick and after every process restart, the macro-controller SHALL reconstruct coarse phase and next action solely from: (1) durable factory contract revisions and claims, (2) linked durable loop/advance run state, and (3) freshly observed external truth via injected GitHub, git, configuration, and child-status seams. Conversation memory, chat transcripts, and ephemeral process-local caches SHALL NOT be required for correctness and SHALL NOT override durable plus live evidence.

#### Scenario: Restart after child start uses durable links

- **WHEN** a child loop was started and its run id was linked on the claim or contract, then the process dies
- **THEN** restart SHALL load the linked run id from durable state and observe child status through the status seam
- **AND** SHALL NOT require an operator to restate the run id from chat history for correct reconciliation

#### Scenario: Ambiguous child result is reconciled from live truth

- **WHEN** a claim is open and child status is ambiguous or missing a terminal outcome
- **THEN** the controller SHALL re-query live child and external truth
- **AND** SHALL record a durable claim outcome only after reconciliation rules produce a definitive completed, failed, or still-in-progress disposition
- **AND** SHALL NOT invent success from the absence of an error message in chat

---

### Requirement: The macro-controller SHALL delegate whole items and SHALL NOT invoke per-stage transitions

The factory macro-controller SHALL progress item work only by starting, resuming, or observing **whole-item** durable loop dispatch and/or whole-issue advance runs. It SHALL NOT call per-stage transition APIs, SHALL NOT set or clear pipeline stage labels as a means of advancing an item, SHALL NOT select model/effort for a stage, and SHALL NOT replace the durable-loop independent scheduler or the recovery controller. Item completion for factory progress SHALL mean the item has reached a terminal whole-item outcome recognized by the linked engine (including `pipeline:ready-to-deploy` for successful product work), not a mid-pipeline stage label change performed by the macro-controller.

#### Scenario: No per-stage API on the macro-controller surface

- **WHEN** the macro-controller module surface is inspected or exercised in unit tests
- **THEN** it SHALL expose child whole-run start/resume/status operations
- **AND** it SHALL NOT expose a function that directly applies a pipeline stage label transition for item work

#### Scenario: Item scheduling remains with the loop supervisor

- **WHEN** the factory contract links a multi-item durable loop run and the macro-controller's next action is to execute items
- **THEN** the controller SHALL start or resume the durable loop supervisor/engine for that run
- **AND** dependency ordering, active-item limits, and recovery attempts SHALL remain owned by the loop engine, supervisor, scheduler, and recovery controller

---

### Requirement: The macro-controller SHALL NOT widen concurrency beyond existing loop policy

Default active-item behavior for factory-linked work SHALL remain **one** active item. When a linked durable loop contract carries an explicit concurrency policy with budget greater than one, the existing proven-independence admission rules of the independent scheduler SHALL remain the sole authority for admitting concurrent items. The macro-controller SHALL NOT raise the concurrency budget, SHALL NOT bypass independence checks, and SHALL NOT start additional whole-item advance processes that evade the loop scheduler's active-item limit.

#### Scenario: No concurrency policy keeps serial behavior

- **WHEN** the linked loop contract has no concurrency policy (or budget one) and the macro-controller is executing
- **THEN** at most one item SHALL be in progress under the loop scheduler
- **AND** the macro-controller SHALL NOT start a second whole-item child to widen concurrency

#### Scenario: Explicit policy remains authoritative

- **WHEN** the linked loop contract has concurrency budget greater than one and independence proofs admit a set
- **THEN** admission SHALL still require the independent scheduler's proof rules
- **AND** the macro-controller SHALL NOT admit additional items beyond that scheduler decision

---

### Requirement: Coarse-action evidence SHALL attribute controller identity and revision

Every coarse action claim and its terminal outcome SHALL record the service controller identity and the execution-contract revision that authorized the action. Run evidence and operator-facing documentation for the factory macro-controller SHALL explain that consumers can determine which controller revision owned each coarse action from those fields.

#### Scenario: Evidence names controller and revision

- **WHEN** a coarse action claim is completed
- **THEN** the durable claim or linked evidence event SHALL include the service controller identity and the contract revision number
- **AND** a read of factory evidence SHALL allow a consumer to answer which revision owned that action without consulting chat logs

#### Scenario: Documentation states attribution fields

- **WHEN** operator documentation for the factory macro-controller is read
- **THEN** it SHALL state that coarse actions are attributed to controller identity and revision in durable evidence
- **AND** SHALL state that the controller is off by default

---

### Requirement: Factory macro-controller tests SHALL inject seams and cover the crash and CAS matrix

Unit tests for the factory macro-controller SHALL inject GitHub, git, clock, contract-store, lock, and child loop/advance service seams and SHALL NOT perform real network, git, or subprocess calls. The suite SHALL include coverage for at least: crash before claim, crash after claim, crash after child start, crash after ambiguous child result, replan success, stale-revision CAS failure, duplicate tick at-most-once dispatch, and legacy run identity linkage/mapping without granting the legacy identity write authority.

#### Scenario: Injected clock and child seams drive reconciliation tests

- **WHEN** a unit test freezes the clock and fakes child status transitions
- **THEN** the controller SHALL reconcile phase and claims using those fakes
- **AND** the test process SHALL not invoke real `gh`, `git`, or child CLIs

#### Scenario: Legacy run identity is recorded without second authority

- **WHEN** a contract links a legacy run identity for import or mapping
- **THEN** tests SHALL prove the macro-controller does not write item ledger transitions through that legacy identity as a second authoritative engine
- **AND** Pipeline factory + native loop stores remain the write authorities for their respective documents
