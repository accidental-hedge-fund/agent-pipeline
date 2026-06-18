## ADDED Requirements

### Requirement: The CLI SHALL recognize `triage` as a sub-command keyword that accepts an issue number

The pipeline CLI dispatch block SHALL accept `triage` as a recognized positional sub-command keyword alongside `intake`, `release`, `sweep`, `roadmap`, `init`, `doctor`, `logs`, `path`, `config`, and `run`. When the first positional argument is the string `triage` (case-sensitive), the CLI SHALL dispatch to the triage handler — passing the second positional argument as the issue number and the `--stage` flag value — without entering the stage-advance loop and SHALL NOT advance any pipeline stage label via the state machine. The string `triage` SHALL appear in the CLI help text in the sub-command listing.

#### Scenario: `triage` dispatched before the advance loop

- **WHEN** the user runs `pipeline triage 42 --stage ready`
- **THEN** the CLI SHALL dispatch the triage handler
- **AND** SHALL NOT enter the advance loop or call any stage handler from the STAGES sequence
- **AND** SHALL NOT read or write any pipeline stage label through the state machine

#### Scenario: `triage` is listed in help text

- **WHEN** the user runs `pipeline --help`
- **THEN** the output SHALL include `triage` in the sub-command listing alongside peer keywords such as `intake`, `release`, `sweep`, and `roadmap`
