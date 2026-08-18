# loop-live-advance-coexistence Specification

## Purpose
TBD - created by archiving change loop-live-advance-coexistence. Update Purpose after archive.

## Requirements

### Requirement: Loop dispatch SHALL not start a second full advance while a host-local advance is already live

Before the durable loop dispatches a full per-item advance through `pipeline/loop-execution@1`, the supervisor SHALL probe host-local evidence for whether an advance is already live for that issue **under the item's domain**. Live evidence SHALL include any of: a per-issue advisory lock held by a live process for that `(domain, issue)` key, a **fresh** non-terminal advance run-store for that issue (activity within the host-local freshness bound; a stale non-terminal crash artifact without recent activity and without live lock/wrapper evidence SHALL NOT count as live), a live wrapper/process identity for that issue under the same domain (production MUST wire a real host-local wrapper/process lookup into the default loop supervisor dependencies — unit tests inject the seam), or a **fresh** non-terminal advance linkage already recorded on the loop run for that item (same freshness bound as active run-stores; aged non-terminal crash linkage SHALL NOT count as live). Lock and detach-marker path resolution used by the probe SHALL use the same domain-scoped issue-run identity as `issue-run-lock` so a live run for issue `N` under domain `A` does not count as live evidence for issue `N` under domain `B`. When live evidence is present, the loop SHALL attach to the existing advance, skip the dispatch cycle for that item, or wait and re-probe — and SHALL NOT spawn a second full advance that can collide on the lock. The multi-item run SHALL NOT record a `run_fatal` stop solely because that item already had a live advance. The probe and disposition SHALL be injectable so unit tests drive them with no real network, git, or subprocess call. Cross-host advance liveness is out of scope; host-local single-host concurrency remains the supported scope.

#### Scenario: Live lock prevents a second full dispatch

- **WHEN** the supervisor would select item `675` for dispatch
- **AND** the live-advance probe reports the per-issue lock held by a live process (or equivalent live run-store / wrapper evidence) for that item's domain
- **THEN** the supervisor SHALL NOT start a second full advance for item `675`
- **AND** it SHALL record a non-fatal attach, skip, or wait disposition for that item
- **AND** it SHALL NOT record a `run_fatal` stop for that coexistence outcome

#### Scenario: Non-terminal loop linkage is treated as live

- **WHEN** the loop run already carries non-terminal start linkage for item `675` with a real advance `pipeline_run_id`
- **AND** that advance is not proven terminal
- **AND** the linked store activity is within the host-local freshness bound
- **THEN** the supervisor SHALL treat the item as having a live advance for pre-dispatch / hold-clear
- **AND** SHALL NOT dispatch a second full advance for the same item until the linked advance is proven terminal, ages past the freshness bound, or the probe reports not live

#### Scenario: No live evidence allows normal dispatch

- **WHEN** the live-advance probe reports not live and no non-terminal loop linkage exists for the item
- **THEN** the supervisor MAY dispatch a full advance under existing scheduler rules
- **AND** this requirement SHALL NOT weaken normal dispatch for clean items

#### Scenario: Stale non-terminal crash store is not live evidence

- **WHEN** the only host-local run-store for an item is non-terminal
- **AND** its activity is older than the host-local freshness bound
- **AND** no live lock and no live wrapper/process identity exist for that item under its domain
- **THEN** the live-advance probe SHALL report not live
- **AND** a subsequent genuine engine defect for that item SHALL still be classifiable under existing `workflow-engine-defect` / `run_fatal` policy

#### Scenario: Aged non-terminal loop linkage is not live evidence

- **WHEN** the loop run retains non-terminal start linkage for an item
- **AND** the linked store activity is older than the host-local freshness bound
- **AND** no live lock and no live wrapper/process identity exist for that item under its domain
- **THEN** the live-advance probe SHALL report not live
- **AND** a subsequent genuine engine defect for that item SHALL still be classifiable under existing `workflow-engine-defect` / `run_fatal` policy

#### Scenario: Production default wiring includes wrapper/process identity

- **WHEN** the durable loop is driven through the production supervisor dependencies (not a unit-test probe override)
- **THEN** the live-advance probe SHALL be able to observe a live wrapper/process identity for an issue under the item's domain
- **AND** that observation SHALL prevent a second full dispatch without requiring a test-only injected full probe override

#### Scenario: Stale detach marker with reused PID is not live wrapper identity

- **WHEN** a host-local detach `.lock` or non-sentinel `.lock-acquired` marker for the item's domain records a numeric PID that currently exists
- **AND** the marker does not carry a verifiable process-identity token that still matches that process (for example process starttime), or the token mismatches because the OS reused the PID after a pre-sentinel crash
- **THEN** the production wrapper/process lookup SHALL treat that marker as not live
- **AND** the live-advance probe SHALL NOT report `wrapper_pid` solely from bare PID liveness
- **AND** a subsequent genuine redispatch for that item SHALL remain possible under normal coexistence and defect policy

#### Scenario: Cross-domain lock does not count as live for this item

- **WHEN** the live-advance probe evaluates item `42` under domain `repo-a`
- **AND** only domain `repo-b` holds a live issue-run lock or detach wrapper identity for issue `42`
- **THEN** the probe SHALL report not live for domain `repo-a` item `42` on lock/wrapper evidence alone
- **AND** the supervisor MAY dispatch under normal rules when no other live evidence exists for `repo-a` #42

### Requirement: Lock-held and already-running dispatch outcomes SHALL be non-fatal coexistence, never workflow-engine-defect run_fatal

When a dispatch returns an outcome that would otherwise normalize to `failed`, and the outcome or its evidence indicates host-local lock held, already running, or install in progress for that issue, the supervisor SHALL classify the result as **non-fatal coexistence** (retryable wait, hold, skip, or noop progress under loop recovery policy). That classification SHALL NEVER use the `workflow-engine-defect` blocker class and SHALL NEVER record a `run_fatal` (or equivalent whole-run stop) solely for that evidence. Pass-2 probe-based coexistence reclassification SHALL require a **concurrent holder** (live lock or live wrapper/process identity) or the structured lock/already-running/install text above — the failed attempt's own non-terminal linkage or fresh crash run-store alone SHALL NOT satisfy Pass-2 coexistence without that concurrent-holder or text evidence. A genuine rejected or crashed dispatch, or an unrecognized terminal outcome, that carries **no** lock / already-running / install-in-progress evidence and **no** concurrent holder SHALL remain classified `workflow-engine-defect` with its existing `run_fatal` policy unchanged. Classification SHALL be a deterministic function of injected dispatch evidence so a unit test proves both the coexistence path and the genuine-defect path.

#### Scenario: Failed dispatch with already-running evidence does not stop the run

- **WHEN** a dispatch for item `675` returns a failed outcome whose evidence includes already-running or lock-held signals (for example the host-local “issue is already running” lock handshake failure)
- **THEN** the supervisor SHALL record a non-fatal coexistence wait, hold, or skip for that item
- **AND** it SHALL NOT classify the item under `workflow-engine-defect`
- **AND** it SHALL NOT record a `run_fatal` run stop
- **AND** other schedulable items in the same multi-item run SHALL remain eligible to continue

#### Scenario: Install-in-progress is treated like lock-held

- **WHEN** a dispatch fails with evidence that worktree or dependency install is already in progress for that issue under host-local mutual exclusion
- **THEN** the supervisor SHALL apply the same non-fatal coexistence disposition as lock-held / already-running
- **AND** it SHALL NOT escalate to `workflow-engine-defect` / `run_fatal` solely for that evidence

#### Scenario: Genuine engine crash without coexistence evidence remains run_fatal

- **WHEN** a dispatch is rejected or crashes, or reports an outcome outside the defined terminal set
- **AND** no lock-held, already-running, or install-in-progress evidence is present
- **AND** no concurrent holder (live lock or wrapper/process identity) exists for the item
- **AND** the item is not under a needs-human `pipeline:blocked` disposition covered by existing hold safety nets
- **THEN** the outcome SHALL be classified `workflow-engine-defect`
- **AND** its existing `run_fatal` policy SHALL apply unchanged

#### Scenario: Fresh crash leaving own non-terminal linkage does not suppress run_fatal

- **WHEN** a dispatch for item `100` records start linkage and then crashes with no lock/already-running text
- **AND** the linked events file is non-terminal and still within the freshness bound
- **AND** no live lock and no live wrapper/process identity exist for that item
- **THEN** Pass-2 SHALL NOT reclassify the failure as coexistence solely from that own linkage/run-store
- **AND** the outcome SHALL remain `workflow-engine-defect` with existing `run_fatal` policy

---

### Requirement: Durable loop events SHALL distinguish coexistence collisions from engine defects

The durable loop run trail (events and/or action-evidence) SHALL record coexistence outcomes with machine-readable markers that distinguish `already_running` / `lock_held` (or equivalent coexistence codes) from genuine engine defects. Each such record SHALL name at least the `item_id` and the coexistence class, and SHALL include optional `pipeline_run_id` and holder process identity when known. Audit consumers SHALL be able to tell that a multi-item run continued (or waited) due to coexistence rather than stopped for `workflow-engine-defect` solely from those durable records.

#### Scenario: Coexistence event is auditable without reading prose logs

- **WHEN** the supervisor applies a non-fatal coexistence disposition for item `675` because an advance is already live
- **THEN** a durable loop-run record SHALL carry `item_id` equal to `675` and a coexistence class such as `already_running` or `lock_held`
- **AND** that record SHALL NOT present the outcome as a `workflow-engine-defect` / `run_fatal` stop

#### Scenario: Genuine defect events remain distinct

- **WHEN** a genuine engine defect stops the run for another item
- **THEN** the durable stop / block records SHALL continue to name `workflow-engine-defect` (and `run_fatal` when policy applies)
- **AND** they SHALL NOT use the coexistence class markers for that defect path

---

### Requirement: Unit tests SHALL cover hold-clear coexistence, lock-failed non-fatal mapping, and genuine-defect regression

The implementation SHALL provide unit / supervisor tests that inject observe, dispatch, live-advance probe, and store seams (no real network, git, or subprocess) and cover: (1) item waiting → blocked label cleared → live advance still running → re-admit does not call a second full dispatch that can fail fatally; (2) dispatch failed with lock/already-running evidence → not `run_fatal` / not whole-run stop; (3) genuine engine crash with no lock evidence still escalates as `workflow-engine-defect` / `run_fatal`. At least one regression SHALL fail against the pre-fix behavior that classified lock collision as `workflow-engine-defect` / `run_fatal`.

#### Scenario: Hold cleared under live advance does not double-dispatch fatally

- **WHEN** a unit test places item `675` in a needs-human hold, clears `pipeline:blocked` on the observe seam, and reports a live advance via the probe
- **THEN** the supervisor cycle SHALL NOT invoke a second full dispatch that records `failed` + `run_fatal`
- **AND** the multi-item run SHALL remain non-terminal for that reason alone

#### Scenario: Lock evidence regression bites without the fix

- **WHEN** a unit test feeds a failed dispatch whose evidence is already-running / lock-held under the pre-fix classification path
- **THEN** a regression assertion that forbids `workflow-engine-defect` / `run_fatal` for that evidence SHALL fail without the coexistence fix
- **AND** SHALL pass with the fix applied

#### Scenario: Genuine defect regression still escalates

- **WHEN** a unit test feeds a crashed or rejected dispatch with no coexistence evidence and no `pipeline:blocked` disposition
- **THEN** the supervisor SHALL still record `workflow-engine-defect` and apply `run_fatal` per policy

### Requirement: A dead prior holder SHALL be takeover of the same item

When the live-advance or coexistence probe observes a recorded holder whose process is dead, whose lock is stale, or whose loop/run directory is a corpse (no live PID and no verifiable live wrapper identity), the supervisor SHALL treat that item as not live. It SHALL take over the same item and resume from the last durable stage (worktree + labels + ledger). It SHALL NOT record `coexistence_wait` for that dead holder. It SHALL NOT wait until a no-progress watchdog fires. A **live** holder (live lock or live wrapper/process identity for the same domain and issue) SHALL remain a non-fatal coexistence wait.

#### Scenario: Dead lock after SIGTERM is takeover

- **WHEN** issue N is `pipeline:implementing`
- **AND** the recorded issue-run lock or wrapper PID is dead
- **AND** no live process identity exists for `(domain, N)`
- **THEN** the supervisor SHALL take over issue N and resume
- **AND** it SHALL NOT record `coexistence_wait` for that dead holder
- **AND** it SHALL NOT STOP the run with `supervisor_no_progress` solely for that evidence

#### Scenario: Six waits on a corpse fail the fixture

- **WHEN** a fixture replays a killed implementer, a recovered dead lock, and a reused loop run id whose holder is dead
- **THEN** the supervisor SHALL take over the same item on the first cycle that observes the dead holder
- **AND** the fixture SHALL fail if the run records two or more `coexistence_wait` outcomes for that corpse
- **AND** the fixture SHALL fail if the run stops with `supervisor_no_progress`

#### Scenario: Live holder still waits

- **WHEN** the probe reports a live lock or live wrapper identity for issue N under its domain
- **THEN** the supervisor SHALL keep the existing non-fatal coexistence wait
- **AND** it SHALL NOT start a second full advance for issue N
