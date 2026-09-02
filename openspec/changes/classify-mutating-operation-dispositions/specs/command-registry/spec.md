## ADDED Requirements

### Requirement: The command registry SHALL be covered by command-form dispositions

Every `COMMAND_REGISTRY` keyword SHALL have at least one row in the executable command-form inventory. Default numeric invocation SHALL map to the `advance` form. Nested subcommands and documented `--dry-run`, `--apply`, and `status` forms SHALL have distinct rows. `mutatesGitHub` SHALL remain the GitHub-write bit for dispatch and SHALL NOT substitute for `execution_disposition`. Flag-only aliases `--cleanup`, `--init`, and `--remove-worktree` SHALL share the disposition of their keyword forms.

#### Scenario: Every registry keyword is inventoried

- **WHEN** `COMMAND_REGISTRY` is enumerated
- **THEN** each key SHALL have at least one command-form inventory row
- **AND** `lookupCommand(undefined)` and numeric lookup SHALL classify as the `advance` form

#### Scenario: mutatesGitHub is not execution disposition

- **WHEN** a registry entry has `mutatesGitHub: true` and the matching form is `bounded-atomic-administration`
- **THEN** flag validation SHALL still treat the command as a GitHub-mutating dispatch
- **AND** RecoverySupervisor durable ownership SHALL NOT be required for that form

#### Scenario: Flag-only cleanup shares cleanup disposition

- **WHEN** the operator invokes `pipeline --cleanup`
- **THEN** the effective form SHALL be `cleanup`
- **AND** its execution disposition SHALL match `pipeline cleanup`
