## ADDED Requirements

### Requirement: Config sync preserves effective behavior while refreshing config structure
The pipeline SHALL provide a config synchronization flow that refreshes an existing `.github/pipeline.yml` against the current starter structure while preserving the effective behavior of explicitly configured values.

#### Scenario: Preview reports drift without writing
- **WHEN** a repository has a valid `.github/pipeline.yml` whose structure differs from the current starter structure
- **THEN** config sync preview SHALL report the proposed change
- **AND** the existing file SHALL remain unchanged

#### Scenario: Apply writes only a behavior-preserving candidate
- **WHEN** config sync apply is run on a valid config
- **THEN** the generated candidate SHALL validate successfully before it is written
- **AND** the effective resolved config after sync SHALL preserve the existing file-configured behavior

#### Scenario: Invalid existing config is not rewritten
- **WHEN** the existing `.github/pipeline.yml` has schema errors or invalid YAML
- **THEN** config sync SHALL report the validation problem
- **AND** it SHALL NOT write a replacement file

#### Scenario: Existing overrides are preserved
- **WHEN** the existing config sets scalar and nested overrides
- **THEN** the synced config SHALL preserve those overrides
- **AND** defaults that were not explicitly configured SHALL remain defaults after sync

### Requirement: Config sync surfaces unknown or unsafe differences as diagnostics
Config sync SHALL refuse to silently migrate unknown, invalid, or behavior-changing config content. Such content SHALL be reported as diagnostics that identify what prevented a safe sync.

#### Scenario: Unknown key blocks apply
- **WHEN** the existing config contains an unknown key
- **THEN** config sync apply SHALL fail
- **AND** the file SHALL remain unchanged

#### Scenario: Preview identifies no-op configs
- **WHEN** the existing config already matches the synced candidate
- **THEN** config sync preview SHALL report that the config is already current
- **AND** no diff SHALL be printed as a required action

