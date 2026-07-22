# detached-launcher Specification

## Purpose
TBD - created by archiving change desktop-contract-host-neutral-launcher. Update Purpose after archive.
## Requirements
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

### Requirement: Advisory lock serializes concurrent launches per issue
The detached wrapper process SHALL acquire the per-issue advisory lock itself, as its first action, and hold it for its own lifetime — so the lock file always names a live process and a launcher death cannot strand it on a dead PID. The launcher SHALL NOT acquire the lock and transfer it to the child after spawning. The launcher SHALL wait for the wrapper to confirm lock ownership (a handshake) before reporting that the run started; if the wrapper reports the lock is already held, the launcher SHALL exit non-zero with a human-readable error. The wrapper SHALL attempt the lock for a configurable timeout (default 5 seconds) and a second `--detach` invocation for the same issue number that cannot acquire it SHALL exit non-zero.

#### Scenario: Launcher death before lock ownership does not strand the lock
- **WHEN** the launching process dies after spawning the wrapper but before the wrapper finishes starting
- **THEN** the per-issue lock file SHALL name the wrapper (a live process), not the dead launcher
- **AND** a later `pipeline run <N> --detach` SHALL NOT treat the lock as stale and start a concurrent duplicate run

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

### Requirement: Detached launch resolves the repo before creating any artifact

The detached launcher SHALL resolve the target repository — the resolved `--repo-path` when
given, otherwise the nearest git root at or above the current working directory — before it
creates any wrapper directory, log file, lock file, run-store pointer, or child process. When
resolution fails, the launcher SHALL exit with code 2, print
`no git repo found at or above <start-dir>. Run from inside a checkout, or pass --repo-path.`,
and SHALL NOT create any filesystem artifact, spawn any process, or report that a run started.
This applies identically to `pipeline <N> --detach` and its `pipeline run <N> --detach` alias.

#### Scenario: Launch from a directory with no git repo refuses before writing

- **WHEN** `pipeline <N> --detach` is invoked from a directory that has no git repository at
  or above it
- **THEN** the launcher SHALL exit with code 2
- **AND** SHALL print `no git repo found at or above <that directory>. Run from inside a checkout, or pass --repo-path.`
- **AND** SHALL NOT print a message reporting that a detached run started

#### Scenario: A refused launch leaves no artifacts anywhere

- **WHEN** a detached launch is refused because the repository cannot be resolved
- **THEN** no wrapper run directory SHALL be created under the user's home pipeline runs root
- **AND** no `pipeline.log`, `sentinel.json`, or `run-store.json` SHALL be created
- **AND** no per-issue lock file SHALL be created
- **AND** the launch directory SHALL contain no `.agent-pipeline/` directory or any other file
  created by the launch

#### Scenario: A refused launch spawns no process

- **WHEN** repository resolution fails for a detached launch
- **THEN** the launcher SHALL NOT spawn the detached wrapper process

#### Scenario: `--repo-path` at a non-repo directory is refused, naming that path

- **WHEN** `pipeline <N> --detach --repo-path <dir>` is invoked and `<dir>` has no git
  repository at or above it
- **THEN** the launcher SHALL exit with code 2 naming the resolved `<dir>` as the start
  directory, not the current working directory
- **AND** SHALL create no artifacts and spawn no process

#### Scenario: The `run` alias behaves identically

- **WHEN** `pipeline run <N> --detach` is invoked from a directory with no git repository at
  or above it
- **THEN** the launcher SHALL refuse with exit code 2 and create no artifacts, exactly as the
  canonical `pipeline <N> --detach` form does

#### Scenario: A resolvable repo launches unchanged

- **WHEN** `pipeline <N> --detach` is invoked from inside a git checkout
- **THEN** the launcher SHALL create the wrapper run directory, spawn the wrapper, write
  `run-store.json`, print the wrapper directory on stdout, and exit 0 as before

