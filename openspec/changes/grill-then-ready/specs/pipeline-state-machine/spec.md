## MODIFIED Requirements

### Requirement: The CLI positional dispatch block SHALL recognize `refine-spec` as a no-issue-number sub-command

The pipeline CLI positional-argument dispatch block SHALL recognize `refine-spec` as a valid no-issue-number keyword alongside existing peers (`init`, `doctor`, `release`, `intake`, `triage`, `sweep`, `merge`). When the first positional argument is `refine-spec`, the orchestrator SHALL dispatch the refine-spec handler. It SHALL NOT treat a following `apply` token or an `--issue` flag as the advance-loop issue number. It SHALL NOT read a stage label for the purpose of advancing the pipeline state machine, and it SHALL NOT advance any `pipeline:*` stage label. `apply` MAY edit the GitHub issue body as specified by `grill-then-ready-refinement`; that body write SHALL NOT be a stage transition.

#### Scenario: `refine-spec` dispatched without issue number

- **WHEN** the user runs `pipeline refine-spec --title "T" --body "B"`
- **THEN** the orchestrator dispatches the refine-spec handler
- **AND** does NOT attempt to resolve an issue number
- **AND** does NOT read or write any `pipeline:*` stage label

#### Scenario: `refine-spec --issue` does not enter advance

- **WHEN** the user runs `pipeline refine-spec --issue 42`
- **THEN** the orchestrator SHALL dispatch the refine-spec handler
- **AND** SHALL NOT start the advance loop for issue 42
- **AND** SHALL NOT write any `pipeline:*` stage label

#### Scenario: `refine-spec apply` does not advance stage

- **WHEN** the user runs `pipeline refine-spec apply --issue 42` with a valid proposal
- **THEN** the orchestrator SHALL dispatch apply
- **AND** SHALL write the issue body when the proposal is valid
- **AND** SHALL NOT add, remove, or replace any `pipeline:*` stage label

#### Scenario: `refine-spec` listed in help text

- **WHEN** `pipeline --help` is invoked
- **THEN** `refine-spec` SHALL appear in the command listing alongside `intake`, `release`, and peer sub-commands
