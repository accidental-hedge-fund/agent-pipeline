## ADDED Requirements

### Requirement: Doctor SHALL sweep provably-dead pipeline locks and warn on stale-lock accumulation

`pipeline doctor` SHALL, as a deterministic maintenance action, sweep `/tmp/pipeline-*.lock` files
whose recorded PID is provably dead (`ESRCH`) or whose contents hold no parseable PID, using the same
liveness semantics `PipelineLock` and the installer's live-run scan apply. It SHALL NOT remove a lock
whose PID is live, nor one that exists but cannot be signalled (`EPERM`, treated conservatively as
live). Doctor SHALL additionally expose a non-blocking `warn` check that surfaces when many stale
pipeline locks have accumulated, so `/tmp` housekeeping does not depend on an `install.mjs update`
ever running. The sweep and the check SHALL remain deterministic and SHALL NOT invoke a language
model, and SHALL be driven through doctor's injectable deps seam so they are unit-testable without
real process signals or real lock files.

#### Scenario: Doctor sweeps a dead-PID lock

- **WHEN** `pipeline doctor` runs and a `/tmp/pipeline-*.lock` records a PID that no longer exists
- **THEN** doctor SHALL unlink that lock file

#### Scenario: Doctor never sweeps a live or unsignalable lock

- **WHEN** a `/tmp/pipeline-*.lock` records a live PID, or a PID that exists but cannot be signalled
  (`EPERM`)
- **THEN** doctor SHALL NOT unlink it

#### Scenario: Doctor warns when stale locks have accumulated

- **WHEN** the number of stale pipeline locks observed exceeds the accumulation threshold
- **THEN** doctor SHALL report a non-blocking `warn` naming the count
- **AND** the `warn` SHALL NOT change doctor's overall pass/fail exit code

#### Scenario: The sweep and warn are unit-testable through the deps seam

- **WHEN** doctor's lock sweep is driven with a fake lock listing and a fake liveness probe
- **THEN** it SHALL unlink exactly the fakes reported dead or unparseable and warn per the injected
  count
- **AND** SHALL perform no real filesystem or process-signal call beyond the injected seams
