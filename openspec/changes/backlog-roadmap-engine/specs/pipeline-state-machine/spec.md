## ADDED Requirements

### Requirement: The CLI SHALL recognize `roadmap` as a no-issue-number sub-command keyword

The pipeline CLI dispatch block SHALL accept `roadmap` as a recognized positional sub-command keyword alongside `intake`, `release`, `init`, `doctor`, `logs`, `path`, `config`, and `run`. When the first positional argument is the string `roadmap` (case-sensitive), the CLI SHALL dispatch to the roadmap handler without requiring an issue number and SHALL NOT advance any pipeline stage label. The string `roadmap` SHALL appear in the CLI help text in the sub-command listing.

#### Scenario: `roadmap` dispatches without an issue number

- **WHEN** the user runs `pipeline roadmap`
- **THEN** the CLI SHALL dispatch the roadmap handler
- **AND** SHALL NOT attempt to resolve or advance any issue stage label
- **AND** SHALL NOT exit with a "missing issue number" error

#### Scenario: `roadmap` is listed in help text

- **WHEN** the user runs `pipeline --help`
- **THEN** the output SHALL include `roadmap` in the list of recognized sub-command keywords alongside peer no-issue-number modes
