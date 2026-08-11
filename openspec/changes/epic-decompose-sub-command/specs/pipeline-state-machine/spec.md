## ADDED Requirements

### Requirement: The CLI SHALL recognize `decompose` as a no-issue-number sub-command keyword

The pipeline CLI dispatch block SHALL accept `decompose` as a recognized positional sub-command keyword alongside `intake`, `roadmap`, `sweep`, `release`, `init`, `doctor`, `logs`, `path`, `config`, and `run`. When the first positional argument is the string `decompose` (case-sensitive), the CLI SHALL dispatch to the decompose handler without requiring an issue-number positional and SHALL NOT advance any pipeline stage label. The string `decompose` SHALL appear in the CLI help text in the sub-command listing.

#### Scenario: `decompose` dispatches without an issue number

- **WHEN** the user runs `pipeline decompose --epic 123`
- **THEN** the CLI SHALL dispatch the decompose handler
- **AND** SHALL NOT attempt to resolve or advance any issue stage label
- **AND** SHALL NOT exit with a "missing issue number" error

#### Scenario: `decompose` is listed in help text

- **WHEN** the user runs `pipeline --help`
- **THEN** the output SHALL include `decompose` in the list of recognized sub-command keywords alongside peer no-issue-number modes
