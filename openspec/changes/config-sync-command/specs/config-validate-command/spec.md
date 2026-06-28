## ADDED Requirements

### Requirement: `pipeline config sync` previews or applies a safe config refresh
The `pipeline config sync [--repo-path <path>] [--apply]` command SHALL refresh an existing `.github/pipeline.yml` using the current config scaffold contract. Without `--apply`, it SHALL run in preview mode and perform no writes. With `--apply`, it SHALL write the refreshed file only after validation succeeds.

#### Scenario: Sync preview exits successfully for valid drift
- **WHEN** the user runs `pipeline config sync` on a valid config that differs from the current scaffold structure
- **THEN** the command SHALL print a human-readable preview of the proposed change
- **AND** the command SHALL exit 0
- **AND** the config file SHALL remain unchanged

#### Scenario: Sync apply writes refreshed config
- **WHEN** the user runs `pipeline config sync --apply` on a valid, safely syncable config
- **THEN** the command SHALL write the refreshed config file
- **AND** it SHALL print a success message naming the updated config file
- **AND** it SHALL exit 0

#### Scenario: Sync fails on missing config
- **WHEN** the user runs `pipeline config sync` in a repository with no `.github/pipeline.yml`
- **THEN** the command SHALL print a clear error directing the user to run `pipeline init`
- **AND** it SHALL exit non-zero

#### Scenario: Sync supports repo-path
- **WHEN** the user runs `pipeline config sync --repo-path <path>`
- **THEN** the command SHALL operate on the `.github/pipeline.yml` at the resolved git root for `<path>`

### Requirement: Config command help advertises sync
The pipeline CLI SHALL advertise `config sync` alongside existing config subcommands so users can discover the maintenance command.

#### Scenario: Config help lists sync
- **WHEN** a user asks for pipeline config command help
- **THEN** the help text SHALL mention `sync` and state that preview is the default

