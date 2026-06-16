## ADDED Requirements

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
