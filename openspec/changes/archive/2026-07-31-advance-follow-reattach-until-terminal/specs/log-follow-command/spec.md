## ADDED Requirements

### Requirement: pipeline logs --events --follow SHALL exit on run_complete by default

When `pipeline logs <run-id> --events --follow` is used, until-terminal mode SHALL be the default: the command SHALL exit successfully (exit code 0) after it has read and printed a complete JSONL line whose advance event type is `run_complete`. Until-terminal detection SHALL apply to lines already present when follow starts as well as lines appended later. An explicit `--no-until-terminal` flag SHALL restore interrupt-only behavior: with that flag, follow SHALL remain open until interrupted (SIGINT/SIGTERM) or the follow cannot be established, and SHALL NOT exit solely because a `run_complete` event was observed. An explicit `--until-terminal` flag MAY be accepted as affirming the default. Without `--follow`, until-terminal flags SHALL be ignored for dump/list modes.

Terminal detection SHALL use the advance run-store event field that writers
emit for completion (`type: "run_complete"`) — implementers SHALL confirm the
field against `run-store` writers and SHALL NOT invent alternate kind names.
Follow mode SHALL still work whether or not the original advance process is
alive. SIGINT/SIGTERM SHALL remain a valid stop condition in both
until-terminal and interrupt-only modes. Help text and command one-liners SHALL
document the until-terminal default and the `--no-until-terminal` opt-out; they
SHALL NOT claim unconditional “no auto-exit on terminal” as the only follow
stop condition for `--events --follow`.

`pipeline logs <run-id> --follow` without `--events` (streaming `terminal.log`)
SHALL remain interrupt-only unless a later change explicitly extends
until-terminal to that path.

#### Scenario: Default events follow exits successfully on run_complete

- **WHEN** `pipeline logs <run-id> --events --follow` is streaming (until-terminal
  default, no `--no-until-terminal`)
- **AND** a complete JSONL line with event type `run_complete` is observed
  (already present at start or newly appended)
- **THEN** the command SHALL print that line to stdout
- **AND** the process SHALL exit with code 0
- **AND** the command SHALL NOT require SIGINT/SIGTERM to end follow after that
  event

#### Scenario: Historical run_complete ends follow without hang

- **WHEN** `pipeline logs <run-id> --events --follow` is invoked
- **AND** the run's `events.jsonl` already contains a `run_complete` event
- **THEN** the command SHALL process existing content and exit with code 0 after
  that terminal event is observed
- **AND** SHALL NOT remain open indefinitely solely because no new lines are
  appended

#### Scenario: --no-until-terminal restores interrupt-only events follow

- **WHEN** `pipeline logs <run-id> --events --follow --no-until-terminal` is
  streaming
- **AND** a `run_complete` event is appended to `events.jsonl`
- **THEN** the command SHALL continue streaming (or remain open on the file)
  until interrupted (SIGINT/SIGTERM) or follow failure
- **AND** SHALL NOT treat the terminal event as an automatic exit condition

#### Scenario: Help documents advance until-terminal default

- **WHEN** an operator reads CLI help or host command one-liners for
  `pipeline logs … --events --follow`
- **THEN** the text SHALL document exit-on-`run_complete` as the default
- **AND** SHALL name `--no-until-terminal` (or equivalent) as the interrupt-only
  opt-out

#### Scenario: terminal.log follow remains interrupt-only by default

- **WHEN** `pipeline logs <run-id> --follow` is invoked without `--events`
- **THEN** the command SHALL stream `terminal.log` until interrupted or follow
  failure
- **AND** SHALL NOT be required by this change to auto-exit solely on
  `run_complete` (which is not a `terminal.log` line contract)

---

### Requirement: Documented supervise-until-terminal pattern SHALL wait on events follow then summary

Installable docs (host skill and/or CLI help) SHALL document a non-interactive supervise pattern that (1) runs `pipeline logs <run-id> --events --follow` under the until-terminal default and (2) after successful exit, runs `pipeline summary <run-id>` (or prints the summary as part of the same documented composition). A dedicated thin subcommand MAY implement the same behavior but is not required if the composition is first-class and copyable.

#### Scenario: Documented composition exits only after terminal then summary

- **WHEN** an operator follows the documented supervise-until-terminal pattern
  for a live or already-complete run-store id
- **THEN** the events follow step SHALL end on `run_complete` (default
  until-terminal) without requiring a manual interrupt for the happy path
- **AND** the pattern SHALL surface `pipeline summary <run-id>` (or equivalent
  summary output) after follow completes successfully

## MODIFIED Requirements

### Requirement: pipeline logs can read or follow structured run events

The CLI SHALL support `pipeline logs <run-id> --events [--follow | -f] [--until-terminal | --no-until-terminal]`. When `--events` is present, the command SHALL use the run directory's `events.jsonl` instead of `terminal.log`, so operators and agent harnesses can monitor lifecycle events without parsing raw combined terminal output or relying on a separate `/tmp` transitions file. Without `--follow`, the command SHALL print the full current contents of `events.jsonl` and exit 0. With `--follow`, the command SHALL stream event lines (including existing content and newly appended lines). When `--follow` is set with `--events`, until-terminal mode SHALL be the default (exit 0 after a `run_complete` event line is printed); `--no-until-terminal` SHALL restore interrupt-only follow. Follow SHALL work whether or not the original pipeline process is still running.

#### Scenario: logs --events prints current event lines

- **WHEN** `pipeline logs <run-id> --events` is invoked without `--follow`
- **THEN** the full current contents of `.agent-pipeline/runs/<run-id>/events.jsonl` SHALL be printed to stdout
- **AND** `terminal.log` SHALL NOT be read for that invocation

#### Scenario: logs --events --follow tails event lines

- **WHEN** `pipeline logs <run-id> --events --follow` is invoked while the run is in progress
- **THEN** new JSON event lines appended to `events.jsonl` SHALL appear on stdout as they are written
- **AND** the command SHALL NOT require any `/tmp/pipeline-<domain>-<N>.transitions.log` file
- **AND** under the until-terminal default the command SHALL exit 0 after a `run_complete` event line is observed

#### Scenario: missing events file reports the selected file name

- **WHEN** `pipeline logs <run-id> --events` is invoked before `events.jsonl` exists
- **THEN** the command SHALL exit non-zero with a diagnostic naming `events.jsonl`
