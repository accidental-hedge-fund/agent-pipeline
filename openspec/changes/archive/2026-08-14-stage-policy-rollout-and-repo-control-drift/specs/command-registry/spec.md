## ADDED Requirements

### Requirement: Repository-control drift check SHALL be registered as a non-mutating command surface

The pipeline CLI command registry SHALL include an entry for the read-only repository-control drift check surface introduced by the `repository-control-drift` capability (exact keyword fixed at implementation, e.g. a dedicated keyword or a doctor-integrated check that is still dispatch-visible). That entry SHALL declare `mutatesGitHub: false` and SHALL NOT declare write flags that enable forge mutation of branch protection, rulesets, or required checks. Flag validation SHALL reject unknown options via the existing allowlist mechanism.

#### Scenario: Registry entry is non-mutating

- **WHEN** the command registry entry for the repository-control drift check surface is inspected
- **THEN** `mutatesGitHub` SHALL be `false`
- **AND** lookup by the chosen keyword SHALL return a non-null entry

#### Scenario: Unsupported write-oriented flag is rejected

- **WHEN** the operator invokes the drift check surface with an explicitly provided option not in its `allowedFlags`
- **THEN** the CLI SHALL exit with code 2 before any GitHub call
- **AND** SHALL NOT mutate forge settings
