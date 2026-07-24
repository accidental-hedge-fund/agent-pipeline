## ADDED Requirements

### Requirement: pipeline logs SHALL be read-only and SHALL NOT hold a run-liveness lock

The launcher SHALL classify `pipeline logs` in every form — listing available runs, printing a run's
`terminal.log` or `events.jsonl`, and streaming either with `--follow` — as a read-only observation
command, and SHALL NOT create or hold any `/tmp/pipeline-*.lock` run-liveness reservation (e.g.
`pipeline-starting-<pid>.lock`) while it runs. A `logs --follow`
process therefore SHALL NOT block a concurrent `install.mjs update`, no matter how long it lives,
because a file swap cannot corrupt a process that is only reading run artifacts. The read-only
classification SHALL be a pure, unit-testable function of the command name, deciding
reserve / do-not-reserve with no real filesystem, process-signal, or subprocess call.

#### Scenario: A logs follower holds no run-liveness lock

- **WHEN** `pipeline logs <run-id> --events --follow` is running
- **THEN** no `pipeline-starting-<pid>.lock` (or any other `pipeline-*.lock` run-liveness
  reservation) SHALL exist on its behalf for the duration of the command

#### Scenario: A long-lived logs follower does not block an update

- **WHEN** a `pipeline logs --follow` follower has been running for hours
- **AND** `install.mjs update` runs concurrently with no genuine advance/queue run present
- **THEN** the installer's live-run scan SHALL find no blocking lock from the follower
- **AND** the update SHALL proceed

#### Scenario: A genuine advance/queue run still defers the update

- **WHEN** a run-mutating command (e.g. an advance or queue run) holds a live
  `pipeline-*.lock` reservation
- **THEN** `install.mjs update` SHALL still refuse to swap files (or warn under `--force`), so the
  read-only exemption does not weaken the #450 live-run deferral

#### Scenario: The read-only classification is a pure function

- **WHEN** the classifier is given the command name `logs`
- **THEN** it SHALL report the command read-only (no reservation)
- **AND** given a run-mutating command name (e.g. `advance`, `loop`, `queue`, `improve`) it SHALL
  report the command run-mutating (reservation required)
- **AND** it SHALL make that decision with no real filesystem, process-signal, or subprocess call
