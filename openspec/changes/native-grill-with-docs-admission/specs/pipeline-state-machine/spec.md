## ADDED Requirements

### Requirement: The CLI positional dispatch block SHALL recognize `grill` as a no-issue-number sub-command

The pipeline CLI positional-argument dispatch block SHALL recognize `grill` as a valid no-issue-number keyword alongside existing peers (`init`, `doctor`, `release`, `intake`, `triage`, `sweep`, `merge`, `refine-spec`). When the first positional argument is `grill`, the orchestrator SHALL dispatch the grill handler. It SHALL NOT treat a following `status` token or an `--issue` flag as the advance-loop issue number. Grill MAY write issue bodies, open a documentation PR, create typed-request handoffs, and request `pipeline:ready` as specified by `grill-with-docs-admission`. Grill SHALL NOT merge or deploy. Grill SHALL NOT add a merge stage to `STAGES`.

#### Scenario: `grill` dispatched without issue number

- **WHEN** the user runs `pipeline grill --issue 42`
- **THEN** the orchestrator SHALL dispatch the grill handler
- **AND** SHALL NOT start the advance loop for issue 42

#### Scenario: `grill status` does not enter advance

- **WHEN** the user runs `pipeline grill status --run-id <id>`
- **THEN** the orchestrator SHALL dispatch grill status
- **AND** SHALL NOT treat `status` as an advance issue number

#### Scenario: `grill` listed in help text

- **WHEN** `pipeline --help` is invoked
- **THEN** `grill` SHALL appear in the command listing alongside `intake`, `release`, and peer sub-commands

#### Scenario: Grill never merges

- **WHEN** `pipeline grill --milestone v1.40.1` runs
- **THEN** the handler SHALL NOT call `merge`, `merge-queue --apply`, `train --merge`, or `ship`

## MODIFIED Requirements

### Requirement: The CLI positional dispatch block SHALL recognize `refine-spec` as a no-issue-number sub-command

The pipeline CLI positional-argument dispatch block SHALL recognize `refine-spec` as a valid no-issue-number keyword alongside existing peers (`init`, `doctor`, `release`, `intake`, `triage`, `sweep`, `merge`, `grill`). When the first positional argument is `refine-spec`, the orchestrator SHALL dispatch the refine-spec handler. It SHALL NOT treat a following `apply` token or an `--issue` flag as the advance-loop issue number. It SHALL NOT read a stage label for the purpose of advancing the pipeline state machine, and it SHALL NOT advance any `pipeline:*` stage label. After replacement coverage, `apply` SHALL NOT remain the admission body writer; that write belongs to `pipeline grill`.

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

- **WHEN** the user runs `pipeline refine-spec apply --issue 42` during migration
- **THEN** the orchestrator SHALL NOT add, remove, or replace any `pipeline:*` stage label

#### Scenario: `refine-spec` listed in help text

- **WHEN** `pipeline --help` is invoked
- **THEN** `refine-spec` SHALL appear in the command listing alongside `intake`, `release`, and peer sub-commands
