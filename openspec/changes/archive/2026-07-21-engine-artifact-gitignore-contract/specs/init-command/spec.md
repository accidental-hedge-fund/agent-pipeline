## ADDED Requirements

### Requirement: Init ensures the engine-managed `.gitignore` artifact block

The `init` command SHALL ensure the engine-managed artifact ignore block in the target
repository's root `.gitignore`, in addition to ensuring labels and scaffolding
`.github/pipeline.yml`. The step SHALL create the `.gitignore` if absent, append the managed
block if the block is missing, and refresh only the block's contents when it is present and
stale. It SHALL never modify lines outside the block. `init` SHALL print a distinct message
for each outcome (created / updated / already current). The ignore step SHALL NOT change
`init`'s existing no-clobber behavior for `.github/pipeline.yml`.

#### Scenario: Fresh repo with no `.gitignore`

- **WHEN** `pipeline init` is run in a repository with no root `.gitignore`
- **THEN** a root `.gitignore` SHALL be created containing the managed artifact block
- **AND** a message SHALL be printed indicating the file was created
- **AND** labels and the `.github/pipeline.yml` scaffold SHALL still be ensured as before

#### Scenario: Repo with an existing `.gitignore`

- **WHEN** `pipeline init` is run in a repository whose `.gitignore` has operator-authored entries and no managed block
- **THEN** the managed block SHALL be appended
- **AND** the operator's existing entries SHALL remain byte-identical

#### Scenario: Re-running init after an engine upgrade adds an artifact directory

- **WHEN** `pipeline init` is re-run after the artifact contract gained a new directory
- **THEN** only the managed block SHALL be rewritten so it lists the new entry
- **AND** a message SHALL be printed indicating the block was updated

#### Scenario: Init is idempotent for the ignore block

- **WHEN** `pipeline init` is run twice in succession with no contract change in between
- **THEN** the second run SHALL perform no write to `.gitignore`
- **AND** a message SHALL be printed indicating the block is already current
- **AND** the command SHALL exit successfully

#### Scenario: Ignore step does not alter config scaffold behavior

- **WHEN** `pipeline init` is run in a repository that already has `.github/pipeline.yml`
- **THEN** the existing config file SHALL remain unmodified and the skip notice SHALL still be printed
- **AND** the `.gitignore` managed block SHALL still be ensured
