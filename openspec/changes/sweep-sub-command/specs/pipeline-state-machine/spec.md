## MODIFIED Requirements

### Requirement: No-issue-number sub-commands are dispatched without advancing stage labels

The pipeline CLI SHALL recognize a fixed set of no-issue-number positional sub-commands — `init`, `doctor`, `logs`, `path`, `config`, `run`, `release`, `intake`, `roadmap`, and `sweep` — and dispatch each to its handler without reading or writing any pipeline stage label. Any unrecognized positional argument that is not a digit string SHALL produce a clear usage error listing the recognized sub-commands.

#### Scenario: `sweep` dispatched without an issue number

- **WHEN** the user runs `pipeline sweep`
- **THEN** the CLI SHALL dispatch to the sweep handler without attempting to resolve an issue number
- **AND** no pipeline stage label SHALL be read or written

#### Scenario: Unrecognized sub-command produces a clear error

- **WHEN** the user runs `pipeline unknowncmd`
- **THEN** the CLI SHALL exit non-zero with an error message listing the recognized no-issue-number sub-commands, including `sweep`

#### Scenario: Help text documents `sweep` alongside peer sub-commands

- **WHEN** the user runs `pipeline --help`
- **THEN** the help output SHALL list `sweep` as a recognized no-issue-number mode alongside `init`, `release`, `intake`, `roadmap`, and the other peer sub-commands
