## ADDED Requirements

### Requirement: The CLI SHALL recognize `backfill` as a no-issue-number sub-command keyword

The pipeline CLI dispatch block SHALL accept `backfill` as a recognized positional sub-command keyword alongside `intake`, `sweep`, `roadmap`, `release`, `init`, `doctor`, `logs`, `path`, `config`, and `run`. When the first positional argument is the string `backfill` (case-sensitive), the CLI SHALL dispatch to the backfill handler without requiring an issue number and SHALL NOT advance any pipeline stage label. The string `backfill` SHALL appear in the CLI help text in the sub-command listing.

#### Scenario: `backfill` dispatches without an issue number

- **WHEN** the user runs `pipeline backfill`
- **THEN** the CLI SHALL dispatch the backfill handler
- **AND** SHALL NOT attempt to resolve or advance any issue stage label
- **AND** SHALL NOT exit with a "missing issue number" error

#### Scenario: `backfill` is listed in help text

- **WHEN** the user runs `pipeline --help`
- **THEN** the output SHALL include `backfill` in the list of recognized sub-command keywords alongside peer no-issue-number modes

#### Scenario: Unrecognized sub-command listing includes `backfill`

- **WHEN** the user runs an unrecognized non-digit positional such as `pipeline unknowncmd`
- **THEN** the CLI SHALL exit non-zero with an error listing the recognized no-issue-number sub-commands, including `backfill`
