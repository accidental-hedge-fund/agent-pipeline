## ADDED Requirements

### Requirement: The command registry SHALL include handoff list, show, answer, reject, and supersede entries

The pipeline CLI command registry SHALL include entries for human-question handoff operations covering at least: non-mutating `list` and `show`, and audited mutating `answer`, `reject`, and `supersede`. Each entry SHALL declare an explicit `allowedFlags` set (including `--json` where JSON output is supported, and documented filter flags for list). Mutating entries SHALL NOT be classified as merge or auto-merge operations. Flag validation for these commands SHALL follow the existing allowlist-based registry rules.

#### Scenario: list and show are registered as non-mutating

- **WHEN** the registry is inspected for handoff list and show entries
- **THEN** each SHALL exist with an explicit allowed flag set
- **AND** neither SHALL be documented as a merge-authorizing command

#### Scenario: answer reject supersede are registered with allowlists

- **WHEN** the registry is inspected for handoff answer, reject, and supersede entries
- **THEN** each SHALL exist with an explicit `allowedFlags` set
- **AND** unknown flags on those commands SHALL be rejected by existing allowlist validation

#### Scenario: registry remains importable without the full CLI

- **WHEN** the command-registry module is imported in isolation
- **THEN** the new handoff entries SHALL be readable without importing the CLI entrypoint side effects beyond existing registry rules
