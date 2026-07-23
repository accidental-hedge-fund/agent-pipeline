## ADDED Requirements

### Requirement: The supervisor SHALL drive a compiled run to a terminal condition through the durable engine

The durable loop supervisor SHALL be an Agent Pipeline-owned in-repo runtime that, given an
already-compiled and locked run, advances that run by repeating a bounded cycle: run a
reconciliation pass over live truth, select the next dependency-ready active item honoring the
contract's `max_active_items: 1`, dispatch that item, and record its outcome through the durable
engine's transition, recovery, and pause paths. The supervisor SHALL continue until the run reaches
a terminal condition — every item done or abandoned, a recorded stop, an outstanding paused/waiting
hold, or a watchdog stop — and SHALL NOT invoke, discover, read, or depend on an externally
installed goal-loop skill on any execution path. The supervisor SHALL NOT create a second ledger,
lock, run-id namespace, or run directory; every durable write it makes SHALL be issued through the
engine into the single authoritative run directory.

#### Scenario: A locked run advances to completion in-repo

- **WHEN** the supervisor is attached to a compiled, locked run whose items are all executable
- **THEN** it SHALL execute the items in dependency order and reach a terminal condition
- **AND** through the injected seams no subprocess invocation of an external goal-loop skill or its
  state CLI SHALL be recorded on any path

#### Scenario: The run halts at the first terminal condition

- **WHEN** a cycle records a stop, an outstanding paused/waiting hold, or leaves no active item
  remaining
- **THEN** the supervisor SHALL stop cycling and report the terminal condition
- **AND** it SHALL NOT create a second ledger, lock, run-id, or run directory

#### Scenario: Only one item is active at a time

- **WHEN** the supervisor selects work for a cycle from a contract whose `max_active_items` is one
- **THEN** it SHALL dispatch at most one item in that cycle
- **AND** it SHALL respect the contract's dependency ordering when choosing which item

---

### Requirement: The supervisor SHALL hand off whole items and never own a pipeline stage

The supervisor SHALL dispatch each selected item as a whole through the `pipeline/loop-execution@1`
contract and SHALL treat only the contract's terminal outcomes (`ready_to_deploy`,
`blocked_needs_human`, `failed`, `abandoned`) as results. It SHALL NOT set, skip, or reorder any
pipeline stage label, SHALL NOT expose or call any per-stage verb, and SHALL NOT merge, release, or
deploy. An item is done only at `pipeline:ready-to-deploy`. An outcome outside the defined terminal
set SHALL be recorded as `failed` and SHALL NOT be silently re-dispatched.

#### Scenario: Stage transitions originate in the advance state machine

- **WHEN** the supervisor drives an item through per-item execution
- **THEN** every pipeline stage-label transition for that item SHALL originate in the per-item advance
  state machine
- **AND** the supervisor SHALL issue no stage-label write and no merge of its own

#### Scenario: Done means ready-to-deploy, not merged

- **WHEN** an item's execution reports `ready_to_deploy`
- **THEN** the ledger SHALL record it as done at `pipeline:ready-to-deploy`
- **AND** the supervisor SHALL perform no merge

#### Scenario: An unrecognized outcome is recorded as failed

- **WHEN** per-item execution reports an outcome outside the defined terminal set
- **THEN** the supervisor SHALL record the item as `failed`
- **AND** it SHALL NOT treat the response as success and SHALL NOT silently re-dispatch the item

---

### Requirement: The supervisor SHALL persist a process-identity record with a refreshed heartbeat

The supervisor SHALL write a durable process-identity record in the run directory when it attaches
to a run, carrying the engine, the process id, the hostname, a per-boot identifier, the start time,
a heartbeat time, and the held lock token. It SHALL refresh the heartbeat time on every cycle. The
record SHALL be distinct from the run lock — the lock governs write authority; the process record
identifies which supervisor process is currently driving and whether it is still alive and
progressing. The record SHALL be written through the store's injectable seam so a unit test drives
it with no real process, network, or git call.

#### Scenario: The process record is written at attach and heartbeats each cycle

- **WHEN** the supervisor attaches to a run and then completes cycles
- **THEN** a process-identity record carrying the engine, pid, hostname, per-boot id, start time,
  heartbeat time, and lock token SHALL exist in the run directory
- **AND** its heartbeat time SHALL advance on each subsequent cycle

#### Scenario: The process record composes with, and does not replace, the lock

- **WHEN** a supervisor holds the run
- **THEN** both the run lock and the process-identity record SHALL be present
- **AND** the process record SHALL NOT be treated as a second write-authority lock

---

### Requirement: The supervisor SHALL detect no-progress and stop rather than spin

The supervisor SHALL classify each cycle as making progress — a durable delta such as an item
transition, a reconciliation change, a recovery attempt, a new block or hold, or a stop — or as
making no progress. After a bounded number of consecutive no-progress cycles it SHALL record a
terminal stop with a dedicated supervisor no-progress reason and halt, rather than continuing to
cycle. This run-level cycle watchdog SHALL be distinct from, and compose with, the item-level
repeated-no-progress bound the recovery policy already enforces; neither SHALL disable the other.

#### Scenario: A spinning run stops instead of looping unbounded

- **WHEN** consecutive cycles produce no durable delta — no eligible item, no drift, no recovery
  attempt, no hold — up to the configured consecutive-no-progress bound
- **THEN** the supervisor SHALL record a terminal stop naming the supervisor no-progress reason
- **AND** it SHALL stop cycling rather than continue indefinitely

#### Scenario: A progressing cycle resets the no-progress count

- **WHEN** a cycle records a durable delta after one or more no-progress cycles
- **THEN** the consecutive-no-progress count SHALL reset
- **AND** the run SHALL continue

---

### Requirement: The supervisor SHALL record an append-only action-evidence trail

The supervisor SHALL append one durable action-evidence entry per cycle to an append-only log in the
run directory, carrying a monotonically increasing sequence number, the time, the item acted on (or
an explicit none), the action taken, the resulting outcome or next action, and the progress
classification for that cycle. The trail SHALL be reconstructable in order so a resuming process or
an auditor can determine exactly what the supervisor did, including across a process restart. The log
SHALL be append-only — entries SHALL NOT be rewritten or removed — and SHALL be written under the run
lock token.

#### Scenario: Each cycle appends one ordered evidence entry

- **WHEN** the supervisor completes a sequence of cycles
- **THEN** the action-evidence log SHALL contain one entry per cycle with strictly increasing
  sequence numbers
- **AND** each entry SHALL record the item acted on or an explicit none, the action, the
  outcome/next-action, and the progress classification

#### Scenario: The trail is append-only

- **WHEN** a new action-evidence entry is written
- **THEN** it SHALL be appended after the existing entries
- **AND** no prior entry SHALL be rewritten or removed

---

### Requirement: Resume SHALL take over a run only when the prior supervisor is provably gone

`--resume <run-id>` SHALL attach a fresh supervisor to an existing run only when the prior holder is
provably gone by the durable store's existing rules — the lock is released, or the lock is held by a
dead process id on the same host and is recovered through the store's provably-dead recovery path.
Before resuming execution the supervisor SHALL run a reconciliation pass so it acts on verified live
truth, SHALL record a resume marker in the action-evidence trail, and SHALL continue from the
ledger's current position without creating a second run, lock, run-id, or run directory. A run whose
recorded contract or ledger schema id is outside the store's supported set SHALL be refused before
any takeover.

#### Scenario: A dead-holder run is resumed after reconciliation

- **WHEN** `--resume <run-id>` targets a run whose lock is held by a same-host dead pid
- **THEN** the supervisor SHALL recover the lock through the store's provably-dead path, run a
  reconciliation pass, and continue from the ledger's current position
- **AND** it SHALL record a resume marker in the action-evidence trail and create no second run,
  lock, or run directory

#### Scenario: A released-lock run is resumed

- **WHEN** `--resume <run-id>` targets a run whose prior supervisor released the lock
- **THEN** the supervisor SHALL acquire the lock and continue the run from its current ledger position

---

### Requirement: Resume SHALL refuse a run whose supervisor is still alive

`--resume <run-id>` SHALL refuse to attach a second supervisor when the run's lock holder is still
alive — a live process id with a fresh heartbeat on the same host, or a holder whose liveness cannot
be verified because it is on a different host. In that case the command SHALL exit non-zero, surface
the existing holder, and perform no ledger write, no lock acquisition, no process-record write, and
no GitHub mutation. Cross-host unverifiable liveness SHALL be treated as not-recoverable, never as
dead, consistent with the documented single-host concurrency scope.

#### Scenario: A live same-host holder is not duplicated

- **WHEN** `--resume <run-id>` targets a run whose lock is held by a live same-host process
- **THEN** the command SHALL exit non-zero and report the existing holder
- **AND** the injected write seams SHALL record no lock acquisition, no ledger write, no
  process-record write, and no GitHub mutation

#### Scenario: A cross-host holder is treated as unrecoverable

- **WHEN** `--resume <run-id>` targets a run whose lock holder is on a different host and its liveness
  cannot be verified
- **THEN** the command SHALL refuse rather than assume the holder is dead
- **AND** it SHALL create no second supervisor

---

### Requirement: Audit mode SHALL be read-only and surface the supervisor timeline

`--audit` SHALL render a read-only report for an existing run drawn from the run's durable artifacts —
the current or last process-identity record, the action-evidence timeline, the watchdog / no-progress
state, and the run's current position — and SHALL perform no durable write of any kind: no ledger
write, no lock acquisition, no process-identity write, and no GitHub mutation. Audit SHALL NOT start
or resume the run, and its output SHALL be derivable entirely from already-persisted artifacts.

#### Scenario: Audit reports the supervisor timeline without mutation

- **WHEN** `--audit` is invoked for an existing run
- **THEN** it SHALL print the process identity, the action-evidence timeline, the watchdog /
  no-progress state, and the run's current position
- **AND** through the injected seams it SHALL record no ledger write, no lock acquisition, no
  process-identity write, and no GitHub mutation

#### Scenario: Audit of a run that never attached a supervisor

- **WHEN** `--audit` is invoked for a run that has no process-identity record yet
- **THEN** it SHALL report the absent process identity without error
- **AND** it SHALL still print whatever action-evidence and position the run has recorded

---

### Requirement: The loop run-start path SHALL NOT require an external goal-loop skill

The `pipeline loop` run-start path SHALL drive the in-repo supervisor and SHALL NOT discover,
require, or invoke an installed external goal-loop skill; its run-start preflight SHALL use the
in-repo durable loop store's schema-compatibility check rather than an external
contract-coherence discovery. The absence of any installed goal-loop skill SHALL NOT fail the
preflight or the run. The documented read-only legacy-run import path SHALL remain available so a
pre-existing run created by a legacy invocation stays addressable by run id.

#### Scenario: A host with no goal-loop skill installed still runs

- **WHEN** `pipeline loop <selector>` is invoked on a host with no goal-loop skill installed at any
  root
- **THEN** the preflight SHALL pass its store-compatibility check and the supervisor SHALL start,
  execute, and report a run id
- **AND** no install-remediation failure SHALL be produced on any path

#### Scenario: A legacy run remains addressable by id

- **WHEN** `--resume <run-id>` names a run created by a legacy goal-loop invocation
- **THEN** it SHALL address that run's contract, ledger, and history through the documented import
  path
- **AND** it SHALL NOT create a second run for that id
