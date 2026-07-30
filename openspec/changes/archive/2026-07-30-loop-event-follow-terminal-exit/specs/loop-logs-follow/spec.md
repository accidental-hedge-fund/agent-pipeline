## MODIFIED Requirements

### Requirement: pipeline loop logs SHALL dump or follow a durable loop run's events.jsonl by run id

The CLI SHALL support a first-class observation command with the signature
`pipeline loop logs <run-id> [--events] [--follow | -f] [--until-terminal | --no-until-terminal]`.
The command SHALL resolve `<run-id>` exclusively under the Pipeline durable loop
state home (the same home order and `runs/<run-id>/` layout defined by the durable
loop store) and SHALL read that run's `events.jsonl`. The selected artifact SHALL
be `events.jsonl` whether or not `--events` is passed (loop runs have no
`terminal.log` in the store contract); `--events` SHALL be accepted for parity
with advance `pipeline logs --events`. Without `--follow`, the command SHALL
print the full current contents of `events.jsonl` to stdout and exit 0. With
`--follow`, the command SHALL stream event lines (including existing content and
newly appended lines) as they become available.

When `--follow` is set, **until-terminal mode SHALL be the default**: the command
SHALL exit successfully (exit code 0) after it has read and printed a complete
JSONL line whose event kind is `loop_run_stopped`. Until-terminal detection SHALL
apply to lines already present when follow starts as well as lines appended later.
An explicit `--no-until-terminal` flag SHALL restore interrupt-only behavior:
with that flag, follow SHALL remain open until interrupted (SIGINT/SIGTERM) or
the follow cannot be established, and SHALL NOT exit solely because a
`loop_run_stopped` event was observed. An explicit `--until-terminal` flag MAY
be accepted as affirming the default. Without `--follow`, until-terminal flags
SHALL be ignored for dump/list modes.

Follow mode SHALL work whether or not the supervisor process that wrote the
events is still alive. The command SHALL still honor SIGINT/SIGTERM as a stop
condition in both until-terminal and interrupt-only modes. The command SHALL NOT
require a git repo, domain config, or GitHub authentication. Help text and
command one-liners SHALL document the until-terminal default and the
`--no-until-terminal` opt-out; they SHALL NOT claim unconditional “no auto-exit
on terminal” as the only follow stop condition.

#### Scenario: One-shot dump prints current events and exits

- **WHEN** `pipeline loop logs <run-id> --events` is invoked without `--follow` for an
  existing durable loop run whose `events.jsonl` is present
- **THEN** the full current contents of that run's `events.jsonl` SHALL be printed to stdout
- **AND** the process SHALL exit with code 0

#### Scenario: Omitting --events still selects events.jsonl

- **WHEN** `pipeline loop logs <run-id>` is invoked without `--events` and without `--follow`
  for an existing durable loop run whose `events.jsonl` is present
- **THEN** the command SHALL print that run's `events.jsonl` (not any other log file)
- **AND** the process SHALL exit with code 0

#### Scenario: Follow streams newly appended event lines

- **WHEN** `pipeline loop logs <run-id> --events --follow` is invoked while the durable loop
  run directory exists and `events.jsonl` is present
- **THEN** event lines from that `events.jsonl` SHALL appear on stdout
- **AND** newly appended lines SHALL appear as they are written until a stop condition
  is met

#### Scenario: Follow works after the supervisor process exits

- **WHEN** the supervisor that wrote the loop events has exited (normally or via crash)
- **AND** `pipeline loop logs <run-id> --events --follow` is invoked against the existing run
  directory
- **THEN** the command SHALL successfully open the run's `events.jsonl` and stream its contents
- **AND** SHALL NOT require the supervisor process to be alive

#### Scenario: Default follow exits successfully on loop_run_stopped

- **WHEN** `pipeline loop logs <run-id> --events --follow` is streaming (until-terminal
  default, no `--no-until-terminal`)
- **AND** a complete JSONL line with event kind `loop_run_stopped` is observed (already
  present at start or newly appended)
- **THEN** the command SHALL print that line to stdout
- **AND** the process SHALL exit with code 0
- **AND** the command SHALL NOT require SIGINT/SIGTERM to end follow after that event

#### Scenario: Historical loop_run_stopped ends follow without hang

- **WHEN** `pipeline loop logs <run-id> --events --follow` is invoked
- **AND** the run's `events.jsonl` already contains a `loop_run_stopped` event
- **THEN** the command SHALL process existing content and exit with code 0 after that
  terminal event is observed
- **AND** SHALL NOT remain open indefinitely solely because no new lines are appended

#### Scenario: --no-until-terminal restores interrupt-only follow

- **WHEN** `pipeline loop logs <run-id> --events --follow --no-until-terminal` is streaming
- **AND** a `loop_run_stopped` event is appended to `events.jsonl`
- **THEN** the command SHALL continue streaming (or remain open on the file) until
  interrupted (SIGINT/SIGTERM) or follow failure
- **AND** SHALL NOT treat the terminal event as an automatic exit condition

#### Scenario: Follow fails closed when the stream cannot start

- **WHEN** `pipeline loop logs <run-id> --events --follow` is invoked but the follow cannot be
  established (e.g. `events.jsonl` is absent or the follow starter errors)
- **THEN** the command SHALL return with a non-zero exit code rather than awaiting forever
- **AND** SHALL print an error diagnostic naming the run id and/or `events.jsonl`

#### Scenario: Help documents until-terminal default

- **WHEN** an operator reads CLI help or the documented command one-liner for
  `pipeline loop logs … --follow`
- **THEN** the text SHALL state that follow exits on `loop_run_stopped` by default
  (or via until-terminal default-on)
- **AND** SHALL name the interrupt-only opt-out (`--no-until-terminal` or equivalent)
- **AND** SHALL NOT claim unconditional “no auto-exit on terminal” without documenting
  the until-terminal default
