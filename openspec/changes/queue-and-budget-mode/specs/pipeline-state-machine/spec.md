## MODIFIED Requirements

### Requirement: No-issue-number sub-commands are dispatched without advancing stage labels

The pipeline CLI SHALL recognize a fixed set of no-issue-number positional sub-commands — `init`, `doctor`, `logs`, `path`, `config`, `run`, `release`, `intake`, `roadmap`, `sweep`, `triage`, `merge`, `refine-spec`, `scoreboard`, and `queue` — and dispatch each to its handler without reading or writing any pipeline stage label. Any unrecognized positional argument that is not a digit string SHALL produce a clear usage error listing the recognized sub-commands.

#### Scenario: `queue` dispatched without an issue number

- **WHEN** the user runs `pipeline queue`
- **THEN** the CLI SHALL dispatch to the queue handler without attempting to resolve an issue number
- **AND** no pipeline stage label SHALL be read or written

#### Scenario: Unrecognized sub-command produces a clear error

- **WHEN** the user runs `pipeline unknowncmd`
- **THEN** the CLI SHALL exit non-zero with an error message listing the recognized no-issue-number sub-commands, including `queue`

#### Scenario: Help text documents `queue` alongside peer sub-commands

- **WHEN** the user runs `pipeline --help`
- **THEN** the help output SHALL list `queue` as a recognized no-issue-number mode alongside `init`, `release`, `intake`, `sweep`, `scoreboard`, and the other peer sub-commands
