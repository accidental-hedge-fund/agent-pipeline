## ADDED Requirements

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
