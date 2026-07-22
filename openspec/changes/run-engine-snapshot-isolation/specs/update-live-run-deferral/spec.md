# update-live-run-deferral

## ADDED Requirements

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
