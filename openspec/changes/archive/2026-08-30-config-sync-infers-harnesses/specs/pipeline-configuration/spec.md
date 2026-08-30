## MODIFIED Requirements

### Requirement: Config sync preserves effective behavior while refreshing config structure

The pipeline SHALL provide a config synchronization flow that refreshes an existing `.github/pipeline.yml` against the current starter structure while preserving the effective behavior of explicitly configured values. When the existing file's only validation errors are omitted required harness roles, sync SHALL be allowed to add inferred `harnesses.implementer` and/or `harnesses.reviewer` values as specified by `config-sync-harness-inference`. That addition SHALL be the only permitted effective-configuration change on an otherwise invalid file.

#### Scenario: Preview reports drift without writing

- **WHEN** a repository has a valid `.github/pipeline.yml` whose structure differs from the current starter structure
- **THEN** config sync preview SHALL report the proposed change
- **AND** the existing file SHALL remain unchanged

#### Scenario: Apply writes only a behavior-preserving candidate

- **WHEN** config sync apply is run on a valid config
- **THEN** the generated candidate SHALL validate successfully before it is written
- **AND** the effective resolved config after sync SHALL preserve the existing file-configured behavior

#### Scenario: Invalid existing config is not rewritten

- **WHEN** the existing `.github/pipeline.yml` has schema errors or invalid YAML other than omitted required harness roles
- **THEN** config sync SHALL report the validation problem
- **AND** it SHALL NOT write a replacement file

#### Scenario: Omitted required harness roles may be added

- **WHEN** the existing `.github/pipeline.yml` is invalid only because `harnesses.implementer` and/or `harnesses.reviewer` is omitted
- **AND** inference succeeds
- **AND** config sync apply runs
- **THEN** the written file SHALL include the inferred missing roles
- **AND** other explicitly configured values SHALL be preserved

#### Scenario: Existing overrides are preserved

- **WHEN** the existing config sets scalar and nested overrides
- **THEN** the synced config SHALL preserve those overrides
- **AND** defaults that were not explicitly configured SHALL remain defaults after sync
