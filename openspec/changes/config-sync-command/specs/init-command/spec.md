## ADDED Requirements

### Requirement: Config sync uses the current init scaffold without changing init no-clobber behavior
The starter structure used by config sync SHALL be the same current structure used when `pipeline init` creates a new `.github/pipeline.yml`. The init command SHALL continue to preserve existing config files without modifying them.

#### Scenario: Sync baseline follows init scaffold
- **WHEN** the starter config template changes for newly initialized repositories
- **THEN** config sync SHALL use that same updated starter structure as its refresh baseline

#### Scenario: Init still skips existing config
- **WHEN** `pipeline init` is run in a repository that already has `.github/pipeline.yml`
- **THEN** init SHALL leave the existing file unchanged
- **AND** it SHALL NOT invoke config sync implicitly
