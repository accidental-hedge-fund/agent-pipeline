# cli-version-flag Specification

## Purpose
TBD - created by archiving change cli-version-flag. Update Purpose after archive.
## Requirements
### Requirement: CLI version flag
The CLI SHALL expose a `--version` flag (short alias `-V`) that prints the current package version and exits with code 0, without requiring an issue number or any GitHub interaction.

#### Scenario: Version flag prints version and exits
- **WHEN** `pipeline --version` is invoked
- **THEN** the CLI prints the current package version string (e.g., `1.0.1`) to stdout and exits with code 0

#### Scenario: Short alias -V is equivalent
- **WHEN** `pipeline -V` is invoked
- **THEN** the CLI prints the current package version string to stdout and exits with code 0

### Requirement: Version sourced from package.json
The CLI SHALL read the version string from `core/package.json` at runtime rather than hardcoding it, so that version bumps are automatically reflected without source changes.

#### Scenario: Version matches package.json
- **WHEN** `pipeline --version` output is compared to the `version` field of `core/package.json`
- **THEN** the two strings are identical

#### Scenario: Version bump is reflected automatically
- **WHEN** `core/package.json` `version` is incremented (e.g., `1.0.1` → `1.0.2`) without modifying pipeline.ts
- **THEN** `pipeline --version` prints the new version string

