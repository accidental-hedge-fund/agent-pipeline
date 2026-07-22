## ADDED Requirements

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
