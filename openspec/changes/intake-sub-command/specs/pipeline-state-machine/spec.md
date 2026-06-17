## MODIFIED Requirements

### Requirement: No-issue-number sub-commands are dispatched without advancing stage labels

The pipeline CLI SHALL recognize a fixed set of no-issue-number positional sub-commands — `init`, `doctor`, `logs`, `path`, `config`, `run`, `release`, and `intake` — and dispatch each to its handler without reading or writing any pipeline stage label. Any unrecognized positional argument that is not a digit string SHALL produce a clear usage error listing the recognized sub-commands.

#### Scenario: `intake` dispatched without an issue number

- **WHEN** the user runs `pipeline intake --description "..."`
- **THEN** the CLI dispatches to the intake handler without attempting to resolve an issue number
- **AND** no pipeline stage label is read or written

#### Scenario: Unrecognized sub-command produces a clear error

- **WHEN** the user runs `pipeline unknowncmd`
- **THEN** the CLI exits non-zero with an error message listing the recognized no-issue-number sub-commands, including `intake`

#### Scenario: Help text documents `intake` alongside peer sub-commands

- **WHEN** the user runs `pipeline --help`
- **THEN** the help output lists `intake` as a recognized no-issue-number mode alongside `init`, `release`, and the other peer sub-commands
