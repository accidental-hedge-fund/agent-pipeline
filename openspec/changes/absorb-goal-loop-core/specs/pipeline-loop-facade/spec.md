## MODIFIED Requirements

### Requirement: Equivalent invocations on either engine SHALL address one canonical durable run

`pipeline:loop` SHALL derive run identity solely from the in-repo durable loop engine's
contract compilation, so that equivalent inputs on the Claude and Codex hosts start or resume
the same run: one run id, one contract, one ledger, one lock. `--resume <run-id>` SHALL
address a run by id regardless of which engine created it, including a run created before
this change by the external goal-loop skill. A run already held by another process SHALL NOT
be started concurrently; the facade SHALL surface the existing lock holder rather than
creating a parallel run.

#### Scenario: Cross-engine resume reuses the same run id

- **WHEN** a run is started under the `claude` adapter and later resumed via
  `$pipeline:loop --resume <run-id>` under the `codex` adapter
- **THEN** the same run id, contract, and ledger SHALL be used
- **AND** no new run record SHALL be created

#### Scenario: Equivalent selectors resolve to the same run

- **WHEN** `/pipeline:loop --milestone v2` and `$pipeline:loop --milestone v2` are
  invoked against the same repository state
- **THEN** both SHALL resolve to the same canonical contract and the same run id
- **AND** the second invocation SHALL resume rather than create a second run

#### Scenario: A locked run is not duplicated

- **WHEN** `pipeline:loop` targets a run whose lock is already held
- **THEN** it SHALL report the existing lock holder and exit without creating a second
  run or a second lock

---

### Requirement: Selected items SHALL execute through the unmodified Pipeline state machine and evidence gates

Every item selected by a loop run SHALL be executed through the normal Agent Pipeline
state machine, review layer, and evidence gates. The facade SHALL NOT set, skip, or
reorder pipeline stage labels itself, SHALL NOT weaken or bypass review, eval, or
pre-merge gates, and SHALL treat an item as done only at `pipeline:ready-to-deploy`.
The facade SHALL NOT merge, and SHALL NOT weaken the durable loop engine's authority,
merge, release, dependency, or reconciliation gates.

#### Scenario: The facade does not move stage labels

- **WHEN** a loop run executes an item
- **THEN** all pipeline stage-label transitions SHALL originate from the Pipeline state
  machine
- **AND** the facade SHALL issue no stage-label write of its own

#### Scenario: Done means ready-to-deploy

- **WHEN** an item's execution reports `ready_to_deploy`
- **THEN** the ledger SHALL record it as done at `pipeline:ready-to-deploy`
- **AND** no merge SHALL be performed by the loop or the facade

#### Scenario: A blocked item does not advance the run past its gates

- **WHEN** an item's execution reports `blocked_needs_human`
- **THEN** the run SHALL record the block and honor the durable loop engine's existing stop
  and reconciliation semantics
- **AND** the item SHALL NOT be recorded as done

---

### Requirement: The preflight SHALL run before any external mutation

`pipeline:loop` SHALL execute its checks in a fixed order: argument normalization
(pure), then the durable loop store's schema-compatibility check, then the native-goal
capability check, and only then contract compilation, lock acquisition, and run
start/resume. Every check before contract compilation SHALL be read-only. A failure in
any of them SHALL exit non-zero with actionable remediation and SHALL leave no external
side effect. The preflight SHALL NOT check for, discover, or require an externally
installed goal-loop skill, and its absence SHALL NOT fail any check.

#### Scenario: An unsupported store schema aborts with zero writes

- **WHEN** a targeted run records a contract or ledger schema id outside the durable loop
  store's supported set and `pipeline:loop` is invoked
- **THEN** the command SHALL exit non-zero naming both the recorded and the supported
  schema ids
- **AND** the injected write seams SHALL record zero calls — no lock, no ledger write,
  no GitHub mutation, no worktree or branch creation

#### Scenario: A missing goal-loop install is not a failure

- **WHEN** `pipeline:loop` is invoked on a host where no goal-loop skill is installed at any
  root
- **THEN** the preflight SHALL pass its store-compatibility check
- **AND** it SHALL proceed to the native-goal capability check and contract compilation

---

### Requirement: Legacy `goal-loop` invocations SHALL remain functional, with deprecation gated on proven evidence

The `/goal-loop` (Claude) and `$goal-loop` (Codex) invocations SHALL, where they remain
installed on a host, continue to address the same runs a `pipeline:loop` invocation would,
via the import path defined for pre-existing runs. Agent Pipeline SHALL NOT require, ship, or
depend on those invocations, and SHALL NOT execute them. A run that Pipeline has imported
SHALL be marked so a legacy invocation cannot drive a divergent second copy of it.

#### Scenario: A pre-existing legacy run is addressable by run id

- **WHEN** `/pipeline:loop --resume <run-id>` names a run created by a legacy `/goal-loop`
  invocation
- **THEN** it SHALL address that run's contract, ledger, and history
- **AND** it SHALL not create a second run for that id

#### Scenario: Pipeline never executes the legacy skill

- **WHEN** any `pipeline:loop` path is exercised through the injected seams
- **THEN** no subprocess invocation of a goal-loop skill or its state CLI SHALL be recorded

## REMOVED Requirements

### Requirement: The facade SHALL delegate all durable state to the installed goal-loop store

**Reason**: Inverted by the #508 product decision — Agent Pipeline is now the sole
implementation and canonical product surface for durable multi-item orchestration, so the
requirement that Pipeline must NOT own a durable state engine is exactly what this change
retires. It is replaced by "The facade SHALL delegate all durable state to the in-repo
durable loop engine" below, which preserves the single-store, no-second-ledger guarantee
while relocating the store.

**Migration**: Durable state moves to the in-repo `durable-loop-store` and
`durable-loop-engine` capabilities. Runs created by the external goal-loop skill are carried
over by the `goal-loop-run-import` capability, which preserves run id, contract, ledger, and
history and refuses to import a run that may still be actively driven.

---

### Requirement: Repository consolidation SHALL remain out of scope pending a recorded live run

**Reason**: This requirement deferred the consolidation decision pending evidence. The
decision has now been taken and recorded on #508: Agent Pipeline becomes the sole
implementation and canonical product surface for durable multi-item orchestration. Keeping a
requirement that forbids absorbing the state engine would directly contradict the change it
gates.

**Migration**: The state engine is absorbed into this repository under the
`durable-loop-engine` and `durable-loop-store` capabilities. Consolidation of the external
goal-loop *repository* itself remains outside this repository's diff — this change removes
Pipeline's runtime dependency on it, and does not merge, archive, delete, or re-release it.

## ADDED Requirements

### Requirement: The facade SHALL delegate all durable state to the in-repo durable loop engine

`pipeline:loop` SHALL NOT create or maintain any durable state of its own. All run identity,
contract compilation, locking, item transitions, decision records, events, reconciliation,
status, and audit output SHALL be produced by the in-repo durable loop engine. The facade
SHALL NOT introduce a second ledger, a second run-id namespace, a second lock, or a second
run directory, and SHALL NOT reimplement any part of the engine inside the command layer.

#### Scenario: No durable writes originate in the facade

- **WHEN** a loop run is exercised end to end against injected fakes
- **THEN** every durable write SHALL have been issued through the durable loop engine's
  interface
- **AND** the facade SHALL have created no ledger, lock, run-id, or run-directory artifact of
  its own

#### Scenario: Exactly one durable store is authoritative

- **WHEN** a run is started, resumed, and audited
- **THEN** all three SHALL read and write the same single run directory under the Pipeline
  state home
- **AND** no second durable store SHALL be consulted except the documented read-only legacy
  import path
