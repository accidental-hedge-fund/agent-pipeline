## ADDED Requirements

### Requirement: This repo's GitHub Actions CI workflow runs the full CI surface

The `.github/workflows/ci.yml` for this repository SHALL invoke `npm run ci` as its test command, rather than manually listing individual sub-steps. The `ci` npm script is the single source of truth for what constitutes a passing gate; duplicating its steps in YAML creates silent drift when the script is updated. By invoking `npm run ci` directly, any future additions to the script (such as `ci:launcher-smoke`) are automatically covered without a parallel YAML change.

#### Scenario: GitHub Actions CI invokes npm run ci

- **WHEN** a push or pull-request event triggers the `ci.yml` workflow
- **THEN** the workflow SHALL invoke `npm run ci` (or an equivalent single entry-point that transitively runs `ci:core`, `build.mjs --check`, `ci:install-smoke`, and `ci:launcher-smoke`)
- **AND** SHALL NOT enumerate those sub-steps as separate workflow steps

#### Scenario: launcher smoke failure fails CI

- **WHEN** `scripts/launcher-smoke.mjs` exits non-zero (e.g., a regression in the launcher)
- **THEN** the GitHub Actions CI job SHALL exit non-zero and the PR SHALL be blocked by CI
- **AND** SHALL NOT pass CI as though the launcher smoke step were absent

#### Scenario: CI log includes launcher smoke output

- **WHEN** a CI run completes successfully
- **THEN** the job log SHALL contain output from the launcher smoke step (e.g., `launcher smoke: N passed, 0 failed`)
- **AND** SHALL NOT omit that output because the step was never invoked
