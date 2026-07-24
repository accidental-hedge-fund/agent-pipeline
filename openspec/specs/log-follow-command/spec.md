# log-follow-command Specification

## Purpose
TBD - created by archiving change desktop-run-artifact-contract. Update Purpose after archive.
## Requirements
### Requirement: pipeline logs <run-id> prints or follows the run's terminal output
The CLI SHALL support a `logs` subcommand with the signature `pipeline logs <run-id> [--follow | -f]`. Without `--follow`, the command SHALL print the full current contents of `terminal.log` for the given run and exit with code 0. With `--follow`, the command SHALL stream new output as it is appended to `terminal.log`, remaining open until interrupted. The command SHALL work regardless of whether the original pipeline process is still running.

#### Scenario: logs without --follow prints and exits
- **WHEN** `pipeline logs <run-id>` is invoked without `--follow`
- **THEN** the full contents of `terminal.log` for that run SHALL be printed to stdout
- **AND** the process SHALL exit with code 0

#### Scenario: logs --follow streams new output as appended
- **WHEN** `pipeline logs <run-id> --follow` is invoked while the run is in progress
- **THEN** new lines appended to `terminal.log` SHALL appear on stdout as they are written
- **AND** the command SHALL remain open until interrupted (SIGINT/SIGTERM)

#### Scenario: logs --follow works after the parent pipeline process exits
- **WHEN** the original pipeline process has exited (normally or via crash)
- **AND** `pipeline logs <run-id> --follow` is invoked
- **THEN** the command SHALL successfully open `terminal.log` and stream its contents
- **AND** SHALL NOT require the original process to be alive

#### Scenario: logs exits non-zero for an unknown run-id
- **WHEN** `pipeline logs <unknown-run-id>` is invoked
- **AND** no run directory exists for that run-id
- **THEN** the process SHALL exit with a non-zero code

#### Scenario: logs --follow does not hang when the follow cannot start
- **WHEN** `pipeline logs <run-id> --follow` is invoked but the follow cannot be established (e.g. `terminal.log` is absent or the tail child exits/errors)
- **THEN** the command SHALL return with a non-zero exit code rather than awaiting forever
- **AND** the run directory SHALL contain `terminal.log` from run-directory initialization so this case does not arise during a normal in-progress run
- **AND** SHALL print an error message naming the unknown run-id

---

### Requirement: pipeline logs lists available run-ids when invoked without a run-id
When `pipeline logs` is invoked with no `<run-id>` argument, the CLI SHALL list the run-ids available in `.agent-pipeline/runs/` (most recent first) and exit with code 0.

#### Scenario: logs with no argument lists available runs
- **WHEN** `pipeline logs` is invoked with no positional argument
- **THEN** the command SHALL print a list of available run-ids, most recent first
- **AND** SHALL exit with code 0

#### Scenario: logs with no argument reports empty when no runs exist
- **WHEN** `pipeline logs` is invoked and `.agent-pipeline/runs/` is empty or absent
- **THEN** the command SHALL print a message indicating no runs are available
- **AND** SHALL exit with code 0

---

### Requirement: pipeline logs can read or follow structured run events
The CLI SHALL support `pipeline logs <run-id> --events [--follow | -f]`. When `--events` is present, the command SHALL use the run directory's `events.jsonl` instead of `terminal.log`, so operators and agent harnesses can monitor lifecycle events without parsing raw combined terminal output or relying on a separate `/tmp` transitions file.

#### Scenario: logs --events prints current event lines
- **WHEN** `pipeline logs <run-id> --events` is invoked without `--follow`
- **THEN** the full current contents of `.agent-pipeline/runs/<run-id>/events.jsonl` SHALL be printed to stdout
- **AND** `terminal.log` SHALL NOT be read for that invocation

#### Scenario: logs --events --follow tails event lines
- **WHEN** `pipeline logs <run-id> --events --follow` is invoked while the run is in progress
- **THEN** new JSON event lines appended to `events.jsonl` SHALL appear on stdout as they are written
- **AND** the command SHALL NOT require any `/tmp/pipeline-<domain>-<N>.transitions.log` file

#### Scenario: missing events file reports the selected file name
- **WHEN** `pipeline logs <run-id> --events` is invoked before `events.jsonl` exists
- **THEN** the command SHALL exit non-zero with a diagnostic naming `events.jsonl`

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

