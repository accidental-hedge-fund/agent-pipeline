## MODIFIED Requirements

### Requirement: The scan and the copy SHALL be one critical section, so a run cannot start unobserved between them

The installer SHALL hold a single exclusive update lock across both the live-run scan and the entire
copy, so a run cannot start in the gap between the scan completing and the copy beginning without
being caught on one side of the race. For a **run-mutating** command the launcher SHALL reserve a
lock-file-shaped slot — matching the same naming pattern the live-run scan already recognizes —
before it spawns the engine subprocess, and SHALL re-check the update lock immediately afterward,
backing off before loading any engine module if the update lock is held at that point. For a
**read-only** command (a command classified read-only per the launcher's read-only-command rule) the
launcher SHALL NOT reserve or hold that slot, so a read-only invocation never appears in the
installer's live-run scan and never defers an update; such a command MAY still decline to start if an
update is already in progress, but SHALL NOT hold a run-liveness lock across its lifetime.

#### Scenario: A run's reservation lands before the installer's scan

- **WHEN** the launcher's reservation is written to disk before the installer's live-run scan runs
- **THEN** the scan SHALL observe it and refuse the update exactly as it would any other live lock

#### Scenario: A run's reservation lands after the installer's scan but before the copy completes

- **WHEN** the launcher creates its reservation while the installer's update lock is already held
- **THEN** the launcher's re-check of the update lock SHALL observe it as held
- **AND** the launcher SHALL back off and SHALL NOT spawn the engine subprocess

#### Scenario: A read-only command reserves no slot and does not defer an update

- **WHEN** the launcher runs a read-only command (e.g. `pipeline logs <run-id> --events --follow`)
- **THEN** it SHALL NOT create or hold any `pipeline-*.lock` run-liveness reservation for that
  command
- **AND** an installer running concurrently SHALL NOT observe a blocking lock from that command and
  SHALL proceed with the update

#### Scenario: A second installer instance cannot proceed while the update lock is held

- **WHEN** an update lock is already held by a live process
- **THEN** a second installer invocation SHALL refuse to proceed rather than racing the first

#### Scenario: A stale update lock does not block

- **WHEN** the update lock file's recorded PID belongs to no live process
- **THEN** the installer SHALL reclaim the lock and proceed normally

#### Scenario: The update lock is always released

- **WHEN** an install/update completes, is refused, or is overridden with `--force`
- **THEN** the update lock file SHALL NOT remain on disk afterward

#### Scenario: A refused or completed run leaves no dangling reservation

- **WHEN** the launcher backs off because the update lock is held, or the engine subprocess exits
- **THEN** its `pipeline-starting-<pid>.lock` reservation SHALL be removed

## ADDED Requirements

### Requirement: The installer SHALL sweep provably-dead pipeline locks during its live-run scan

While scanning `/tmp/pipeline-*.lock` for live runs, the installer SHALL unlink any lock file whose
recorded PID is provably dead — the liveness probe returns `ESRCH` — or whose contents hold no
parseable PID, using the same liveness semantics `PipelineLock` and the live-run scan already apply.
The installer SHALL NOT unlink a lock whose PID is live, nor one that exists but cannot be signalled
(`EPERM`, treated conservatively as live); those SHALL remain and continue to block or override
exactly as they do today. The sweep SHALL be a side effect of the existing scan and SHALL NOT change
the installer's refusal, `--force`, or update-lock semantics.

#### Scenario: A dead-PID lock is swept during the scan

- **WHEN** the installer scans and a `/tmp/pipeline-*.lock` records a PID that no longer exists
- **THEN** that lock file SHALL be unlinked
- **AND** it SHALL NOT count as a blocking live lock

#### Scenario: A live lock is never swept

- **WHEN** a `/tmp/pipeline-*.lock` records the PID of a live process
- **THEN** the installer SHALL NOT unlink it
- **AND** it SHALL still defer the update (or warn under `--force`) as before

#### Scenario: An unsignalable lock is retained

- **WHEN** a `/tmp/pipeline-*.lock` records a PID that exists but cannot be signalled (`EPERM`)
- **THEN** the installer SHALL NOT unlink it
- **AND** SHALL treat it conservatively as live

#### Scenario: The stale sweep is unit-testable through the same seams

- **WHEN** the scan is driven with a fake lock listing and a fake liveness probe
- **THEN** it SHALL unlink exactly the fakes reported dead or unparseable
- **AND** SHALL perform no real filesystem or process-signal call beyond the injected seams
