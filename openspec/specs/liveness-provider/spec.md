# liveness-provider Specification

## Purpose
Defines a host-neutral Liveness Provider that restores or reattaches a machine-local durable supervisor after worker or machine restart without owning recovery policy, answering requests, merging, or creating a second ledger.

## Requirements

### Requirement: The Liveness Provider SHALL be separate from the outer session Host and from RecoverySupervisor

The Liveness Provider SHALL restore workers for an existing Logical Operation. It SHALL discover machine-local durable runs, claim a fenced same-host lease, start or reattach the same supervisor, refresh worker identity, follow events, and relinquish on terminal evidence. It SHALL NOT classify faults, choose recovery recipes, answer Decision, Capability, or Authority Requests, merge, release, deploy, or create another ledger or scheduler. The outer session Host SHALL launch, follow, reattach, answer, cancel, and notify through CLI semantics. RecoverySupervisor SHALL remain the sole recovery-policy owner after a worker is restored.

#### Scenario: Provider restores a dead worker without choosing recovery

- **WHEN** a non-terminal durable run has a dead worker on the current host
- **THEN** the Liveness Provider SHALL claim the fenced lease and reattach the same supervisor
- **AND** it SHALL NOT select a recovery recipe, emit a typed request, or merge

#### Scenario: Host cannot become a retry controller

- **WHEN** an outer session Host observes a dead worker or interrupted follow
- **THEN** the Host SHALL invoke the shared liveness restore or portable follow CLI
- **AND** it SHALL NOT classify the fault or retry the supervised operation itself

---

### Requirement: The Liveness Provider SHALL discover eligible machine-local durable runs

The Liveness Provider SHALL enumerate durable runs on the current host whose Logical Operation is not verified-complete, not cancelled, and not a genuine current typed request that forbids resume. Eligibility SHALL require a durable resume binding (run identity plus ledger or handoff evidence). A non-terminal ledger alone SHALL NOT prove a live worker. A live worker SHALL NOT be restored a second time. Discovery SHALL be same-host only.

#### Scenario: Non-terminal run with a dead worker is eligible

- **WHEN** a durable run on this host has a non-terminal ledger and worker liveness `not-live`
- **THEN** that run SHALL be eligible for restore
- **AND** restore SHALL reuse the existing run identity

#### Scenario: Verified completion is not eligible

- **WHEN** the Logical Operation already has verified completion
- **THEN** the run SHALL NOT be eligible for restore
- **AND** the provider SHALL NOT start a new supervisor for that identity

#### Scenario: Cross-host ledgers are not discovered as local

- **WHEN** a lock or worker identity records a different hostname
- **THEN** the provider SHALL NOT treat that run as a same-host restore candidate
- **AND** it SHALL NOT claim cross-host mutual exclusion

---

### Requirement: Concurrent launchers SHALL coordinate through a fenced same-host lease

The Liveness Provider SHALL claim the existing host-local fencing identity before it starts or reattaches a supervisor. The fence SHALL reuse the issue-run lock and durable-loop store lock (process identity plus opaque token), including pid and starttime so PID reuse cannot steal the lease. A second launcher for the same durable run on the same host SHALL observe the live holder and SHALL NOT start a duplicate supervisor. Scope SHALL remain single-host. Remote correctness SHALL NOT depend on a new distributed lock or lease service.

#### Scenario: Two restore attempts serialize on one host

- **WHEN** two launchers attempt to restore the same eligible run on one host
- **THEN** exactly one SHALL obtain the fenced lease and attach the supervisor
- **AND** the other SHALL exit without starting a second supervisor
- **AND** it SHALL report the live holder rather than a logical terminal

#### Scenario: PID reuse cannot steal the fence

- **WHEN** a lock records a pid whose starttime no longer matches
- **THEN** the provider SHALL treat that holder as not the original worker
- **AND** it SHALL NOT follow the recycled process as the supervisor

---

### Requirement: Restore SHALL reattach the same supervisor and refresh worker identity

The Liveness Provider SHALL start or reattach the same durable supervisor for an eligible run after it claims the fence. It SHALL keep that run identity. It SHALL refresh worker identity (process id, starttime, boot identity, heartbeat) after attach. It SHALL NOT mint a new Logical Operation. Autonomous restore, cooling wake-up, and bound resume SHALL NOT count as manual reinvocation. systemd, launchd, container, and harness-worker adapters SHALL implement this same attach contract. After attach, the restored supervisor SHALL reconcile outstanding Recovery Episode claims whose side-effect certainty is uncertain before any new mutation. The provider SHALL NOT choose recovery recipes.

#### Scenario: Worker death then restore keeps the same run identity

- **WHEN** the supervisor process exits and the ledger is still non-terminal
- **THEN** restore SHALL reattach using the existing run identity
- **AND** the new worker identity SHALL replace the dead identity on the fence
- **AND** a new Logical Operation SHALL NOT be minted

#### Scenario: Restore reports attached only after supervisor handshake

- **WHEN** restore spawns a replacement supervisor
- **AND** that process has not yet acquired the replacement fence and written a valid worker identity
- **THEN** restore SHALL NOT report attached
- **AND** it SHALL NOT persist the spawned pid as the recorded worker

#### Scenario: systemd and launchd use the same restore contract

- **WHEN** a systemd unit, launchd job, container entrypoint, or harness worker restores after restart
- **THEN** it SHALL invoke the same discover, claim, reattach, follow, and relinquish contract
- **AND** it SHALL NOT carry a host-specific recovery recipe

#### Scenario: Restore reconciles uncertain claims before mutation

- **WHEN** restore attaches after process death
- **AND** a Recovery Episode claim is `started` with uncertain certainty
- **THEN** the restored supervisor SHALL observe the authoritative observer before any new mutation
- **AND** the Liveness Provider SHALL NOT itself replay or repair that side effect

---

### Requirement: A dead worker SHALL NOT make the Logical Operation terminal

Physical worker death, missing heartbeat, or machine restart SHALL be liveness `not-live` or `unknown`. Those states SHALL NOT be verified completion, ownerless terminal, or human authority. The provider SHALL NOT claim physical progress while no worker or machine is running. Followers SHALL treat interrupted follow as non-terminal.

#### Scenario: Killed worker leaves the ledger owned

- **WHEN** the supervisor process is killed and no terminal evidence exists
- **THEN** the Logical Operation SHALL remain non-terminal
- **AND** status and doctor SHALL NOT project human authority from that death

#### Scenario: Not-live is not verified completion

- **WHEN** liveness is `not-live` and the exact-candidate postcondition is unproven
- **THEN** the provider SHALL NOT treat wrapper exit, sentinel, or `run_complete` absence as verified completion
- **AND** it SHALL NOT claim that work is physically progressing

---

### Requirement: Event follow SHALL remain observational and SHALL NOT change lifecycle state

The Liveness Provider SHALL treat event follow as observational. It MAY follow `events.jsonl` through the existing logs follow CLI after attach. Follow, #1302 observational delivery, and collector replay SHALL NOT advance, retry, merge, release, cancel, or terminalize the Logical Operation. Relinquish SHALL occur only after terminal evidence that RecoverySupervisor already owns (verified success, Cooling wait that needs no worker, genuine typed request, or authenticated cancellation).

#### Scenario: Follow interruption does not complete the run

- **WHEN** a host follow is cancelled or the follower process exits before terminal evidence
- **THEN** the Logical Operation SHALL remain non-terminal
- **AND** the host SHALL reattach follow or invoke restore rather than emit completion

#### Scenario: Observational sink failure does not change lifecycle

- **WHEN** #1302 delivery or a collector fails while a worker is live or not-live
- **THEN** GitHub state, Pipeline ledgers, retry budgets, and merge authority SHALL remain unchanged

---

### Requirement: The CLI SHALL expose liveness status and restore without recovery policy

The pipeline CLI SHALL expose a liveness status surface consumed by `pipeline doctor` and a restore surface that launchers invoke. Status SHALL report `configured`, `available`, `active`, or `degraded` / `unavailable` with a typed capability condition when continuous liveness cannot run. Restore SHALL perform discover, claim, reattach, follow-handoff, and relinquish-on-terminal only. The CLI SHALL NOT add a recovery-policy verb, a second scheduler, or a merge path under liveness.

#### Scenario: Status names a typed capability condition when unavailable

- **WHEN** no keep-alive adapter is configured or the configured adapter cannot run
- **THEN** liveness status SHALL be `unavailable` or `degraded`
- **AND** the condition SHALL be a typed capability condition
- **AND** the condition SHALL NOT be classified as human authority

#### Scenario: Restore does not classify faults

- **WHEN** restore reattaches a supervisor that later needs recovery
- **THEN** restore SHALL hand observations to RecoverySupervisor through existing supervisor semantics
- **AND** the liveness CLI SHALL NOT choose a recipe or park the item as needs-human

---

### Requirement: Liveness restore and status SHALL be unit-testable through injected deps

Discover, liveness probe, fence claim, identity refresh, doctor status projection, and restore sequencing SHALL accept injected filesystem, process-identity, heartbeat, and lock seams. Unit tests SHALL perform no real network, git, or subprocess calls. A fixture where the worker is dead and the ledger is non-terminal SHALL fail if restore mints a new run identity, starts a second supervisor, or projects human authority.

#### Scenario: Dead-worker fixture fails a duplicate supervisor

- **WHEN** a unit test injects a non-terminal ledger and a dead pid
- **AND** restore is invoked twice through the injected lock seam
- **THEN** the second invoke SHALL not receive a second fence
- **AND** the test SHALL perform no real network, git, or subprocess call

#### Scenario: Human-authority projection fails the fixture

- **WHEN** a unit test injects worker death without a genuine typed request
- **THEN** the fixture SHALL fail if status or doctor classifies that death as human authority

### Requirement: Fenced takeover SHALL invalidate the dead token and SHALL NOT mutate first

After a same-host holder is provably dead, takeover SHALL claim a fresh fenced lease using the existing issue-run lock and durable-loop store lock (process id, starttime, and a new opaque token). The dead holder's token SHALL NOT authorize mutation. Takeover SHALL reconcile uncertain side effects before mutation. Scope SHALL remain single-host. Remote correctness SHALL NOT depend on a new distributed lock or lease service.

#### Scenario: Dead token cannot mutate after takeover

- **WHEN** takeover recovers a dead same-host lock and publishes a new token
- **THEN** a mutating operation that presents the previous token SHALL be refused
- **AND** the refusal SHALL name the new holder

#### Scenario: Takeover of a live holder is refused

- **WHEN** a second launcher observes a live same-host holder
- **THEN** it SHALL NOT take over the fence
- **AND** it SHALL NOT start a duplicate supervisor
