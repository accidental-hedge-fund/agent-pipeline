## ADDED Requirements

### Requirement: Detached run survives launcher exit
The CLI SHALL support a `--detach` flag on `pipeline run <issue>` that spawns the pipeline run in a new process group so the run continues advancing after the launching process exits or receives SIGTERM.

#### Scenario: Run keeps advancing after launcher exits
- **WHEN** `pipeline run <issue> --detach` is invoked and the invoking process subsequently exits
- **THEN** the pipeline run SHALL continue advancing the issue through the state machine

#### Scenario: SIGTERM on launcher does not kill detached run
- **WHEN** SIGTERM is sent to the process that launched `pipeline run <issue> --detach`
- **THEN** the pipeline run process SHALL NOT receive the SIGTERM signal

#### Scenario: Non-detached run exits with launcher (no regression)
- **WHEN** `pipeline run <issue>` is invoked without `--detach`
- **THEN** the run lifecycle SHALL be unchanged from the current behavior

#### Scenario: Detached run preserves no-write and lifecycle flags
- **WHEN** `pipeline run <issue> --detach` is invoked together with a no-write or lifecycle flag (`--dry-run`, `--once`, `--doctor`, or `--fail-fast`)
- **THEN** the detached pipeline process SHALL receive that flag
- **AND** `--detach --dry-run` SHALL NOT create labels, comments, worktrees, commits, or PRs

### Requirement: Completion sentinel written atomically on every exit path
The detached run process SHALL write a `sentinel.json` file to its run directory via an atomic rename on every exit path — normal completion, unhandled exception, SIGTERM from a watchdog, and watchdog-initiated SIGKILL — so that a poller can distinguish running / done / crashed without parsing prose output.

#### Scenario: Normal completion writes sentinel
- **WHEN** a detached run finishes successfully
- **THEN** `<run-dir>/sentinel.json` SHALL exist and contain `{ "exitCode": 0, "durationMs": <number>, "completedAt": <ISO-8601> }`

#### Scenario: Failed run writes sentinel with non-zero exit code
- **WHEN** a detached run exits due to an unhandled error
- **THEN** `<run-dir>/sentinel.json` SHALL exist and contain `{ "exitCode": <non-zero>, "durationMs": <number>, "completedAt": <ISO-8601> }`

#### Scenario: Sentinel file appears atomically
- **WHEN** the sentinel is being written
- **THEN** a poller that observes `sentinel.json` in the run directory SHALL be able to read the complete file without observing a partial write

#### Scenario: Running run has no sentinel
- **WHEN** a detached run is still in progress
- **THEN** `<run-dir>/sentinel.json` SHALL NOT exist

### Requirement: Advisory flock serializes concurrent launches per issue
The detached launcher SHALL acquire an advisory flock on a per-issue lock file before spawning the child process and hold it for the child's lifetime. A second `--detach` invocation for the same issue number SHALL attempt the flock for a configurable timeout (default 5 seconds) and exit non-zero with a human-readable error message if the lock cannot be acquired.

#### Scenario: Concurrent launch for the same issue is rejected
- **WHEN** `pipeline run <N> --detach` is already running
- **AND** a second `pipeline run <N> --detach` is invoked
- **THEN** the second invocation SHALL exit with a non-zero exit code
- **AND** SHALL print a message indicating issue `<N>` is already running

#### Scenario: Different issue numbers are not serialized
- **WHEN** `pipeline run <A> --detach` and `pipeline run <B> --detach` are invoked concurrently for different issue numbers
- **THEN** both SHALL acquire their respective locks and run concurrently without interference

#### Scenario: Lock is released when the run completes
- **WHEN** a detached run for issue `<N>` completes and its process exits
- **THEN** a subsequent `pipeline run <N> --detach` invocation SHALL be able to acquire the lock and start a new run

### Requirement: Timeout watchdog terminates hung runs
When invoked with `--timeout <seconds>`, the detached process SHALL start a watchdog timer. If the run has not completed before the timer expires, the watchdog SHALL terminate the run's full process tree — every process group created by the run, including descendants that placed themselves in their own process group — with SIGKILL, and write a sentinel with a non-zero exit code and `"timedOut": true`.

#### Scenario: Watchdog fires on timeout
- **WHEN** `pipeline run <issue> --detach --timeout 300` is invoked
- **AND** the run has not completed after 300 seconds
- **THEN** the run SHALL be terminated
- **AND** `sentinel.json` SHALL contain `{ "exitCode": -1, "timedOut": true, "durationMs": <number>, "completedAt": <ISO-8601> }`

#### Scenario: Watchdog terminates detached descendant process groups
- **WHEN** the watchdog fires while a run step has spawned shell/setup/harness work in its own process group
- **THEN** the watchdog SHALL terminate those descendant process groups, not only the wrapper's own group
- **AND** no descendant process belonging to the run SHALL remain alive after the timeout sentinel is written

#### Scenario: No watchdog without --timeout
- **WHEN** `pipeline run <issue> --detach` is invoked without `--timeout`
- **THEN** no watchdog timer SHALL be set and the run may run indefinitely
