# update-live-run-deferral Specification

## Purpose
TBD - created by archiving change run-engine-snapshot-isolation. Update Purpose after archive.
## Requirements
### Requirement: The installer SHALL refuse to overwrite an installed core while a live run holds a lock

Before copying any file over an existing installed core, the installer SHALL scan for pipeline lock
files at `/tmp/pipeline-*.lock` and determine, for each, whether the recorded PID is live using the
same liveness semantics `PipelineLock` uses: a signalable process is live, `ESRCH` means stale, and
a process that exists but cannot be signalled is treated conservatively as live. When at least one
live lock is found, the installer SHALL refuse the update, exit non-zero, and leave every installed
file unmodified.

#### Scenario: Update refuses while a run is live

- **WHEN** `install.mjs update` runs and `/tmp/pipeline-lyric-utils-420.lock` holds the PID of a
  live process
- **THEN** the installer SHALL exit non-zero
- **AND** SHALL copy no file into any host skills directory

#### Scenario: Refusal leaves the existing install byte-identical

- **WHEN** the update is refused because of a live lock
- **THEN** every file of the previously installed core SHALL be unchanged, including any file the
  installer would have copied first

#### Scenario: Stale locks do not block an update

- **WHEN** the only pipeline lock files present record PIDs of processes that no longer exist
- **THEN** the update SHALL proceed normally

#### Scenario: Unparseable lock contents do not block an update

- **WHEN** a pipeline lock file contains no parseable PID
- **THEN** the lock SHALL be treated as stale
- **AND** the update SHALL proceed normally

#### Scenario: No locks present

- **WHEN** no `/tmp/pipeline-*.lock` file exists
- **THEN** the update SHALL proceed normally

#### Scenario: A first install onto a host with no existing core is not guarded

- **WHEN** the installer targets a host that has no previously installed core
- **THEN** the live-lock guard SHALL NOT prevent the install

### Requirement: The refusal SHALL name the blocking runs and the way forward

The refusal output SHALL identify each blocking lock by path and PID, state that a pipeline run is
in progress and that updating would swap files underneath it, and tell the operator to retry when
those runs finish or to re-run with `--force`.

#### Scenario: Refusal output identifies each blocking lock

- **WHEN** two live locks block an update
- **THEN** the output SHALL name both lock paths and both PIDs

#### Scenario: Refusal output states the remedy

- **WHEN** an update is refused
- **THEN** the output SHALL mention both waiting for the run to finish and the `--force` flag

### Requirement: `--force` SHALL override the deferral while still disclosing the risk

When `--force` is passed, the installer SHALL perform the update despite live locks, and SHALL print
the same blocking-lock details as a warning rather than an error.

#### Scenario: Forced update proceeds

- **WHEN** `install.mjs update --force` runs with a live lock present
- **THEN** the installer SHALL complete the update and exit zero

#### Scenario: Forced update still discloses the blocking runs

- **WHEN** a forced update overrides a live lock
- **THEN** the output SHALL warn, naming each overridden lock path and PID

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

### Requirement: The live-run scan SHALL be a pure, injectable, tested function

The scan SHALL be exposed as a function taking lock-file discovery and PID-liveness seams, so tests
can assert refusal and pass-through behavior without creating real lock files or real processes.

#### Scenario: Unit test drives the scan through fakes

- **WHEN** the scan is given a fake lock listing and a fake liveness probe
- **THEN** it SHALL report the blocking locks derived from those fakes
- **AND** SHALL perform no real filesystem or process-signal call

#### Scenario: Installer guard regression test bites

- **WHEN** the live-run guard is removed from the installer
- **THEN** the installer test SHALL observe a copy where it expected a refusal and fail

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

