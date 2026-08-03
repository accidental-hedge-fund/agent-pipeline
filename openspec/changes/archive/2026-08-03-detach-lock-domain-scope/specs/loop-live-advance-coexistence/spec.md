## MODIFIED Requirements

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
