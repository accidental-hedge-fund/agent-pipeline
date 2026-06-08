## ADDED Requirements

### Requirement: Explicit CI command covers full CI surface
When `test_gate.command` is set in `.github/pipeline.yml`, the gate MUST execute that command verbatim and treat its exit code as the gate result. The configured command is the operator's declaration that this command is equivalent to the repo's CI — a gate pass implies a CI pass for the covered steps.

#### Scenario: Compound command with passing test and failing CI-only step blocks the gate
- **WHEN** `test_gate.command` is set to a compound command (e.g., `npm test && node scripts/build.mjs --check`)
- **AND** the first command (`npm test`) exits 0
- **AND** the second command (`node scripts/build.mjs --check`) exits non-zero (e.g., due to a stale generated mirror)
- **THEN** the gate SHALL report failure and block before opening a PR

#### Scenario: Compound command where all steps pass allows the pipeline to proceed
- **WHEN** `test_gate.command` is set to a compound command
- **AND** all chained commands exit 0
- **THEN** the gate SHALL report success and allow the pipeline to continue

### Requirement: Operator documentation for CI parity
The pipeline documentation (README) SHALL include a section explaining that if a repo's CI runs additional steps beyond the auto-detected `test` script (e.g., artifact sync checks, type checks, lint), the operator MUST set `test_gate.command` to a command that covers those additional steps.

#### Scenario: README documents when to set test_gate.command
- **WHEN** a developer reads the test/build gate section of the README
- **THEN** they SHALL find guidance stating that `test_gate.command` must match the repo's full CI command when CI includes steps beyond the default `test` script

#### Scenario: pipeline.yml includes inline comment for CI parity
- **WHEN** a developer looks at `.github/pipeline.yml` for this repo
- **THEN** they SHALL see a comment on or near `test_gate.command` explaining that the value matches the repo's full CI command (`npm test && node scripts/build.mjs --check`)

### Requirement: This repo's pipeline config sets the full CI command
This repo's `.github/pipeline.yml` SHALL set `test_gate.command` to `"npm test && node scripts/build.mjs --check"`, matching the commands run by this repo's CI pipeline.

#### Scenario: pipeline.yml for agent-pipeline specifies the full CI command
- **WHEN** the agent-pipeline repo's `.github/pipeline.yml` is read
- **THEN** `test_gate.command` SHALL equal `"npm test && node scripts/build.mjs --check"`
