## MODIFIED Requirements

### Requirement: Config sync uses the current init scaffold without changing init no-clobber behavior

The starter structure used by config sync SHALL be the same current structure used when
`pipeline init` creates a new `.github/pipeline.yml`, so `config sync` SHALL introduce
newly-added commented options and refreshed guidance into an existing config while preserving the
operator's explicitly set values and unrelated comments/formatting. Config sync SHALL refuse to
write when the re-rendered candidate would change effective configuration, except that adding
inferred omitted `harnesses.implementer` and/or `harnesses.reviewer` values as specified by
`config-sync-harness-inference` SHALL be allowed. The init command SHALL
continue to preserve existing config files without modifying them.

#### Scenario: Sync baseline follows init scaffold

- **WHEN** the starter config template changes for newly initialized repositories
- **THEN** config sync SHALL use that same updated starter structure as its refresh baseline

#### Scenario: Sync introduces newly-added documented options

- **WHEN** the schema gains a new documented option and `config sync` is applied to an existing valid `.github/pipeline.yml`
- **THEN** the refreshed file SHALL include the new option's commented documentation and any refreshed guidance
- **AND** the operator's explicitly configured values SHALL be preserved unchanged

#### Scenario: Sync refuses to change effective configuration

- **WHEN** `config sync` re-renders an existing config and the candidate would change the effective configuration other than adding inferred omitted harness roles
- **THEN** config sync SHALL refuse to write the candidate and report the condition

#### Scenario: Sync may add inferred omitted harness roles

- **WHEN** `config sync` is applied to a file whose only errors are omitted required harness roles
- **AND** inference succeeds
- **THEN** config sync SHALL be allowed to write the inferred roles
- **AND** it SHALL NOT treat that addition as a refused effective-configuration change

#### Scenario: Init still skips existing config

- **WHEN** `pipeline init` is run in a repository that already has `.github/pipeline.yml`
- **THEN** init SHALL leave the existing file unchanged
- **AND** it SHALL NOT invoke config sync implicitly
