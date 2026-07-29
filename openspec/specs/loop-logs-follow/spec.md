# loop-logs-follow Specification

## Purpose
TBD - created by archiving change loop-logs-follow. Update Purpose after archive.
## Requirements
### Requirement: pipeline loop logs SHALL dump or follow a durable loop run's events.jsonl by run id

The CLI SHALL support a first-class observation command with the signature
`pipeline loop logs <run-id> [--events] [--follow | -f]`. The command SHALL resolve
`<run-id>` exclusively under the Pipeline durable loop state home (the same home order
and `runs/<run-id>/` layout defined by the durable loop store) and SHALL read that run's
`events.jsonl`. The selected artifact SHALL be `events.jsonl` whether or not `--events` is
passed (loop runs have no `terminal.log` in the store contract); `--events` SHALL be
accepted for parity with advance `pipeline logs --events`. Without `--follow`, the command
SHALL print the full current contents of `events.jsonl` to stdout and exit 0. With
`--follow`, the command SHALL stream newly appended lines as they are written (tail
semantics) and SHALL remain open until interrupted (SIGINT/SIGTERM) or the follow cannot be
established. Follow mode SHALL work whether or not the supervisor process that wrote the
events is still alive, and SHALL NOT auto-exit solely because the run has recorded a
terminal stop event. The command SHALL NOT require a git repo, domain config, or GitHub
authentication.

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
- **THEN** new lines appended to that `events.jsonl` SHALL appear on stdout as they are written
- **AND** the command SHALL remain open until interrupted (SIGINT/SIGTERM)

#### Scenario: Follow works after the supervisor process exits

- **WHEN** the supervisor that wrote the loop events has exited (normally or via crash)
- **AND** `pipeline loop logs <run-id> --events --follow` is invoked against the existing run
  directory
- **THEN** the command SHALL successfully open the run's `events.jsonl` and stream its contents
- **AND** SHALL NOT require the supervisor process to be alive

#### Scenario: Follow does not auto-exit on a terminal stop event

- **WHEN** `pipeline loop logs <run-id> --events --follow` is streaming
- **AND** a terminal stop event (e.g. `loop_run_stopped`) is appended to `events.jsonl`
- **THEN** the command SHALL continue streaming (or remain open on the file) until interrupted
- **AND** SHALL NOT treat the terminal event as an automatic exit condition

#### Scenario: Follow fails closed when the stream cannot start

- **WHEN** `pipeline loop logs <run-id> --events --follow` is invoked but the follow cannot be
  established (e.g. `events.jsonl` is absent or the tail starter errors)
- **THEN** the command SHALL return with a non-zero exit code rather than awaiting forever
- **AND** SHALL print an error diagnostic naming the run id and/or `events.jsonl`

---

### Requirement: pipeline loop logs SHALL resolve the events path through the loop state home

Path resolution for `pipeline loop logs` SHALL use the durable loop store's state-home
precedence and run-directory layout: an explicit Pipeline state-home environment override
when set, otherwise the XDG state directory under `agent-pipeline/loop`, otherwise the
home-relative default `~/.local/state/agent-pipeline/loop`, with each run at
`<state-home>/runs/<run-id>/events.jsonl`. The command SHALL reject path-unsafe run ids
(path separators, `.`, `..`, or any id that would resolve outside the runs root) without
performing a directory traversal. Resolution SHALL NOT consult `.agent-pipeline/runs/` or
any legacy goal-loop state home.

#### Scenario: State-home override is honored

- **WHEN** the Pipeline state-home override environment variable is set to an absolute path
- **AND** `pipeline loop logs <run-id> --events` is invoked for a run that exists under that
  home
- **THEN** the command SHALL read `<override>/runs/<run-id>/events.jsonl`

#### Scenario: Default layout is used when no override is set

- **WHEN** no Pipeline state-home override is set
- **AND** a durable loop run exists under the default home-relative state home
- **AND** `pipeline loop logs <run-id> --events` is invoked
- **THEN** the command SHALL read
  `~/.local/state/agent-pipeline/loop/runs/<run-id>/events.jsonl` (or the XDG-resolved
  equivalent when `XDG_STATE_HOME` is set)

#### Scenario: Path-unsafe run ids are rejected

- **WHEN** `pipeline loop logs` is invoked with a run id containing a path separator or `..`
- **THEN** the command SHALL exit non-zero
- **AND** SHALL NOT read or write any path outside the runs root

#### Scenario: Advance run store is never consulted

- **WHEN** `pipeline loop logs <run-id> --events` is invoked
- **THEN** the command SHALL NOT read `.agent-pipeline/runs/<run-id>/events.jsonl` as the
  primary source for that invocation

---

### Requirement: pipeline loop logs SHALL list available loop run ids when invoked without a run id

When `pipeline loop logs` is invoked with no `<run-id>` argument, the CLI SHALL list the
durable loop run ids available under the resolved loop state home's `runs/` directory (most
recent first when ordering is available) and exit with code 0. When no loop runs exist, the
command SHALL print a message indicating that no loop runs are available and still exit 0.

#### Scenario: List mode prints available loop run ids

- **WHEN** `pipeline loop logs` is invoked with no positional run id
- **AND** one or more durable loop run directories exist under `<state-home>/runs/`
- **THEN** the command SHALL print those run ids
- **AND** SHALL exit with code 0

#### Scenario: List mode reports empty when no loop runs exist

- **WHEN** `pipeline loop logs` is invoked and the state home's `runs/` directory is empty or
  absent
- **THEN** the command SHALL print a message indicating no loop runs are available
- **AND** SHALL exit with code 0

---

### Requirement: pipeline loop logs SHALL fail clearly for unknown or incomplete runs

The CLI SHALL exit non-zero when the run directory for the given id does not exist under the
resolved loop state home, and SHALL print an error that names the unknown run id and the
expected layout (`<state-home>/runs/<run-id>/` or the expected `events.jsonl` path). When the
run directory exists but `events.jsonl` is not yet present and the invocation is a one-shot
dump (no `--follow`), the command SHALL exit non-zero with a diagnostic naming `events.jsonl`.

#### Scenario: Unknown run id names the expected state-home layout

- **WHEN** `pipeline loop logs <unknown-run-id> --events` is invoked
- **AND** no directory exists at `<state-home>/runs/<unknown-run-id>/`
- **THEN** the process SHALL exit with a non-zero code
- **AND** the error message SHALL name the unknown run id
- **AND** the error message SHALL include the expected path under the resolved loop state home

#### Scenario: Missing events file on dump names events.jsonl

- **WHEN** `pipeline loop logs <run-id> --events` is invoked without `--follow`
- **AND** the run directory exists but `events.jsonl` is absent
- **THEN** the process SHALL exit non-zero
- **AND** the diagnostic SHALL name `events.jsonl`

---

### Requirement: pipeline loop logs SHALL be read-only and SHALL NOT hold a run-liveness lock

The launcher and CLI SHALL treat every form of `pipeline loop logs` — listing runs, dumping
`events.jsonl`, and following with `--follow` — as a read-only observation command. The
command SHALL NOT acquire the durable loop store lock, SHALL NOT write the ledger, contract,
process-identity record, or any other durable run artifact, and SHALL NOT create or hold any
`/tmp/pipeline-*.lock` run-liveness reservation (e.g. `pipeline-starting-<pid>.lock`) while it
runs. Classification of the nested `logs` sub-verb as read-only SHALL be a pure, unit-testable
function of the command argv (or equivalent command identity) with no real filesystem,
process-signal, or subprocess call. A genuine `pipeline loop` start/resume path SHALL remain
classified as run-mutating so the read-only exemption does not weaken live-run update
deferral.

#### Scenario: A loop logs follower holds no run-liveness lock

- **WHEN** `pipeline loop logs <run-id> --events --follow` is running
- **THEN** no `pipeline-starting-<pid>.lock` (or any other `pipeline-*.lock` run-liveness
  reservation) SHALL exist on its behalf for the duration of the command

#### Scenario: Loop logs does not acquire the durable store lock

- **WHEN** `pipeline loop logs <run-id> --events` dumps or follows events for a run whose lock
  is held by another process
- **THEN** the command SHALL succeed without acquiring or requiring a lock token
- **AND** SHALL perform no durable write under the run directory

#### Scenario: Nested logs is classified read-only while loop drive remains mutating

- **WHEN** the classifier is given argv identifying `pipeline loop logs`
- **THEN** it SHALL report the command read-only (no reservation)
- **AND** when given argv identifying a loop start or resume (no `logs` sub-verb) it SHALL
  report the command run-mutating
- **AND** it SHALL make that decision with no real filesystem, process-signal, or subprocess
  call

