## MODIFIED Requirements

### Requirement: Init does not clobber an existing `.github/pipeline.yml`
If `.github/pipeline.yml` already exists on disk at the resolved `configPath` — regardless of whether it is tracked by git — `init` SHALL skip the scaffolding step and print a clear notice, then continue to ensure labels.

#### Scenario: Config file already exists (tracked)
- **WHEN** `init` is run and `.github/pipeline.yml` is already present and tracked by git
- **THEN** the existing file is not modified
- **AND** a notice is printed such as: `.github/pipeline.yml already exists — skipping scaffold`
- **AND** label ensure still runs and completes successfully

#### Scenario: Config file already exists (untracked)
- **WHEN** `init` is run and `.github/pipeline.yml` exists on disk but is not tracked by git (e.g., hand-created, app-generated, or absent from a derived worktree's index)
- **THEN** the existing file is not modified
- **AND** a notice is printed such as: `.github/pipeline.yml already exists — skipping scaffold`
- **AND** label ensure still runs and completes successfully

#### Scenario: Config file does not exist
- **WHEN** `init` is run and no `.github/pipeline.yml` exists at the resolved path
- **THEN** the file is created with the default scaffold template
- **AND** a success message is printed indicating the file was created

## ADDED Requirements

### Requirement: Regression test covers the untracked-file no-clobber path
The unit test suite SHALL include a test that specifically exercises the untracked-file overwrite scenario: a `.github/pipeline.yml` is written directly to disk (simulating an untracked file), `scaffoldDefaultConfig` is called, and the test asserts that `{ created: false }` is returned and the file content is unchanged.

#### Scenario: Regression test bites before the fix
- **WHEN** the explicit `existsSync` guard is removed from `scaffoldDefaultConfig`
- **THEN** the regression test fails, proving it covers the real failure mode

#### Scenario: Regression test passes after the fix
- **WHEN** the `existsSync` guard is present
- **THEN** the regression test passes along with all other init tests
