## ADDED Requirements

### Requirement: The CLI positional dispatch block SHALL recognize `refine-spec` as a no-issue-number sub-command

The pipeline CLI positional-argument dispatch block SHALL recognize `refine-spec` as a valid no-issue-number keyword alongside existing peers (`init`, `doctor`, `release`, `intake`, `triage`, `sweep`, `merge`). When the first positional argument is `refine-spec`, the orchestrator SHALL dispatch the refine-spec handler and SHALL NOT attempt to resolve an issue number, read a stage label, or advance the pipeline state machine.

#### Scenario: `refine-spec` dispatched without issue number

- **WHEN** the user runs `pipeline refine-spec --title "T" --body "B"`
- **THEN** the orchestrator dispatches the refine-spec handler
- **AND** does NOT attempt to resolve an issue number
- **AND** does NOT read or write any `pipeline:*` stage label

#### Scenario: `refine-spec` listed in help text

- **WHEN** `pipeline --help` is invoked
- **THEN** `refine-spec` SHALL appear in the command listing alongside `intake`, `release`, and peer sub-commands
