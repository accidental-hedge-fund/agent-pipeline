## ADDED Requirements

### Requirement: The command registry SHALL include a train entry with an explicit flag allowlist

The declarative command registry SHALL include a `train` command entry. The entry SHALL declare documentation metadata and an explicit `allowedFlags` set that includes the work selectors and train controls required by integrated train mode (at minimum selectors for issues and/or milestone, `--merge`, status/json output flags used by the implementation, and the standard repo/base/profile allowlist members the implementation accepts). Flags outside that allowlist SHALL be rejected before any train mutation.

#### Scenario: Train is registered

- **WHEN** the command registry is loaded
- **THEN** it SHALL contain a `train` entry with documentation metadata

#### Scenario: Disallowed flags are rejected

- **WHEN** an operator runs `pipeline train` with a flag not on the train allowlist
- **THEN** the CLI SHALL exit with code 2 naming the offending flag
- **AND** no train mutation SHALL occur

#### Scenario: Registry cross-check covers train

- **WHEN** the registry/CLI allowlist cross-validation tests run
- **THEN** the `train` entry SHALL be included in bidirectional allowlist checks
