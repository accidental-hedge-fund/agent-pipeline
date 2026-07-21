# init-command Specification

## Purpose
TBD - created by archiving change init-command-scaffold-pipeline-config. Update Purpose after archive.
## Requirements
### Requirement: Init command runs without an issue number
The pipeline CLI SHALL accept `init` as a sub-command that requires no issue number argument and that does not advance any pipeline stage.

#### Scenario: Invoked with no issue number
- **WHEN** the user runs `/pipeline init` (or `$pipeline init`)
- **THEN** the command exits successfully without touching any issue, PR, or pipeline stage label

#### Scenario: Invoked with an issue number (invalid)
- **WHEN** the user runs `/pipeline init 42`
- **THEN** the command ignores the trailing argument and still only performs init work (or prints an error and exits — implementations may choose either; the key constraint is no stage advance occurs)

---

### Requirement: Init ensures all pipeline labels idempotently
The `init` command SHALL call `ensurePipelineLabels` for the target repo, creating any missing labels and leaving existing labels unchanged.

#### Scenario: Labels do not exist yet
- **WHEN** `init` is run on a repo with no pipeline labels
- **THEN** all pipeline labels (`pipeline:<stage>`, `pipeline:blocked`, `harness:claude`, `harness:codex`) are created in the repo

#### Scenario: Labels already exist
- **WHEN** `init` is run on a repo where all pipeline labels already exist
- **THEN** no labels are modified, no errors are thrown, and the command exits successfully

#### Scenario: Some labels exist, some are missing
- **WHEN** `init` is run and only a subset of pipeline labels are present
- **THEN** only the missing labels are created; existing labels are left unchanged

---

### Requirement: Init scaffolds `.github/pipeline.yml` when absent
The `init` command SHALL write a `.github/pipeline.yml` starter template when no such file exists in the target repo. The template SHALL contain every commonly-overridden key at its default value, each annotated with an inline YAML comment explaining the key.

#### Scenario: Config file does not exist
- **WHEN** `init` is run and `.github/pipeline.yml` is absent
- **THEN** a `.github/pipeline.yml` file is written containing commented default key-value pairs
- **AND** a success message is printed indicating the file was created

#### Scenario: Scaffolded config is valid against the schema
- **WHEN** the scaffolded `.github/pipeline.yml` is parsed by `resolveConfig`
- **THEN** `resolveConfig` returns without throwing and the resulting config matches `DEFAULT_CONFIG` for every key present in the file

---

### Requirement: Init does not clobber an existing `.github/pipeline.yml`
If `.github/pipeline.yml` already exists, `init` SHALL skip the scaffolding step and print a clear notice, then continue to ensure labels.

#### Scenario: Config file already exists
- **WHEN** `init` is run and `.github/pipeline.yml` is already present
- **THEN** the existing file is not modified
- **AND** a notice is printed such as: `.github/pipeline.yml already exists — skipping scaffold`
- **AND** label ensure still runs and completes successfully

---

### Requirement: Init is idempotent and safe to re-run
Running `init` multiple times on the same repo SHALL produce the same observable state each time, with no errors.

#### Scenario: Re-run after first init
- **WHEN** `init` is run a second time on a repo where `init` was already run
- **THEN** existing labels are left unchanged, the existing config file is preserved, and the command exits successfully

---

### Requirement: Normal pipeline advance still self-creates labels
When a user runs `/pipeline N` (the advance path) without having run `init` first, `ensurePipelineLabels` SHALL still be called as it is today. `init` is additive and introduces no new precondition for normal pipeline use.

#### Scenario: Advance run on a repo with no prior init
- **WHEN** `/pipeline 42` is run on a repo where `init` was never called
- **THEN** labels are created during the advance run exactly as before this change

---

### Requirement: README documents `init` as the recommended first step
The README SHALL include a section explaining `init` as the recommended onboarding command for a fresh repo, showing the invocation and summarizing what it does.

#### Scenario: New adopter reads the README
- **WHEN** a user reads the README to onboard a new repo
- **THEN** they find a clear description of `init`, its invocation, and what it sets up (labels + starter config)

---

### Requirement: Unit tests cover init behavior
The implementation SHALL include unit tests for: (1) label-ensure path, (2) scaffold-config-when-absent, (3) no-clobber-when-present, (4) scaffolded-config validity via round-trip through `resolveConfig`.

#### Scenario: Tests pass in CI
- **WHEN** `pnpm test` is run
- **THEN** all four test cases pass without errors

### Requirement: Init scaffolds a commented-out documented `repo_map` block

The `.github/pipeline.yml` scaffolded by `init` (and by `config sync`) SHALL include a
`repo_map` block that is commented out by default, with inline documentation describing the
two relationship lists (`depends_on`, `depended_on_by`), the `owner/repo` entry format, and
that the relationship is declared independently per repo. Because the block is commented out,
the scaffolded file SHALL still round-trip through `resolveConfig()` to the `repo_map` default
(both lists empty), preserving the existing "scaffolded config equals defaults" guarantee.

#### Scenario: scaffolded config contains the documented repo_map block

- **WHEN** `init` scaffolds `.github/pipeline.yml`
- **THEN** the file SHALL contain a commented-out `repo_map` block
- **AND** the block's comments SHALL document `depends_on`, `depended_on_by`, and the `owner/repo` entry format

#### Scenario: scaffolded repo_map keeps the config valid against defaults

- **WHEN** the scaffolded `.github/pipeline.yml` is parsed by `resolveConfig()`
- **THEN** parsing SHALL succeed
- **AND** `config.repo_map.depends_on` SHALL equal `[]`
- **AND** `config.repo_map.depended_on_by` SHALL equal `[]`

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

