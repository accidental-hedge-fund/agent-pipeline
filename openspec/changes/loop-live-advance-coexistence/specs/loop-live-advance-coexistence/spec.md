## ADDED Requirements

### Requirement: Loop dispatch SHALL not start a second full advance while a host-local advance is already live

Before the durable loop dispatches a full per-item advance through `pipeline/loop-execution@1`, the supervisor SHALL probe host-local evidence for whether an advance is already live for that issue. Live evidence SHALL include any of: a per-issue advisory lock held by a live process, a **fresh** non-terminal advance run-store for that issue (activity within the host-local freshness bound; a stale non-terminal crash artifact without recent activity and without live lock/wrapper evidence SHALL NOT count as live), a live wrapper/process identity for that issue (production MUST wire a real host-local wrapper/process lookup into the default loop supervisor dependencies — unit tests inject the seam), or a non-terminal advance linkage already recorded on the loop run for that item. When live evidence is present, the loop SHALL attach to the existing advance, skip the dispatch cycle for that item, or wait and re-probe — and SHALL NOT spawn a second full advance that can collide on the lock. The multi-item run SHALL NOT record a `run_fatal` stop solely because that item already had a live advance. The probe and disposition SHALL be injectable so unit tests drive them with no real network, git, or subprocess call. Cross-host advance liveness is out of scope; host-local single-host concurrency remains the supported scope.

#### Scenario: Live lock prevents a second full dispatch

- **WHEN** the supervisor would select item `675` for dispatch
- **AND** the live-advance probe reports the per-issue lock held by a live process (or equivalent live run-store / wrapper evidence)
- **THEN** the supervisor SHALL NOT start a second full advance for item `675`
- **AND** it SHALL record a non-fatal attach, skip, or wait disposition for that item
- **AND** it SHALL NOT record a `run_fatal` stop for that coexistence outcome

#### Scenario: Non-terminal loop linkage is treated as live

- **WHEN** the loop run already carries non-terminal start linkage for item `675` with a real advance `pipeline_run_id`
- **AND** that advance is not proven terminal
- **THEN** the supervisor SHALL treat the item as having a live advance
- **AND** SHALL NOT dispatch a second full advance for the same item until the linked advance is proven terminal or the probe reports not live

#### Scenario: No live evidence allows normal dispatch

- **WHEN** the live-advance probe reports not live and no non-terminal loop linkage exists for the item
- **THEN** the supervisor MAY dispatch a full advance under existing scheduler rules
- **AND** this requirement SHALL NOT weaken normal dispatch for clean items

#### Scenario: Stale non-terminal crash store is not live evidence

- **WHEN** the only host-local run-store for an item is non-terminal
- **AND** its activity is older than the host-local freshness bound
- **AND** no live lock and no live wrapper/process identity exist for that item
- **THEN** the live-advance probe SHALL report not live
- **AND** a subsequent genuine engine defect for that item SHALL still be classifiable under existing `workflow-engine-defect` / `run_fatal` policy

#### Scenario: Production default wiring includes wrapper/process identity

- **WHEN** the durable loop is driven through the production supervisor dependencies (not a unit-test probe override)
- **THEN** the live-advance probe SHALL be able to observe a live wrapper/process identity for an issue
- **AND** that observation SHALL prevent a second full dispatch without requiring a test-only injected full probe override

#### Scenario: Stale detach marker with reused PID is not live wrapper identity

- **WHEN** a host-local detach `.lock` or non-sentinel `.lock-acquired` marker records a numeric PID that currently exists
- **AND** the marker does not carry a verifiable process-identity token that still matches that process (for example process starttime), or the token mismatches because the OS reused the PID after a pre-sentinel crash
- **THEN** the production wrapper/process lookup SHALL treat that marker as not live
- **AND** the live-advance probe SHALL NOT report `wrapper_pid` solely from bare PID liveness
- **AND** a subsequent genuine redispatch for that item SHALL remain possible under normal coexistence and defect policy

---

### Requirement: Lock-held and already-running dispatch outcomes SHALL be non-fatal coexistence, never workflow-engine-defect run_fatal

When a dispatch returns an outcome that would otherwise normalize to `failed`, and the outcome or its evidence indicates host-local lock held, already running, or install in progress for that issue, the supervisor SHALL classify the result as **non-fatal coexistence** (retryable wait, hold, skip, or noop progress under loop recovery policy). That classification SHALL NEVER use the `workflow-engine-defect` blocker class and SHALL NEVER record a `run_fatal` (or equivalent whole-run stop) solely for that evidence. A genuine rejected or crashed dispatch, or an unrecognized terminal outcome, that carries **no** lock / already-running / install-in-progress evidence SHALL remain classified `workflow-engine-defect` with its existing `run_fatal` policy unchanged. Classification SHALL be a deterministic function of injected dispatch evidence so a unit test proves both the coexistence path and the genuine-defect path.

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
- **AND** the item is not under a needs-human `pipeline:blocked` disposition covered by existing hold safety nets
- **THEN** the outcome SHALL be classified `workflow-engine-defect`
- **AND** its existing `run_fatal` policy SHALL apply unchanged

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
