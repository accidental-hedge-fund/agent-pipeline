## ADDED Requirements

### Requirement: The CI gate validates the OpenSpec workspace when present

The repo's full CI gate (`npm run ci`) SHALL run `openspec validate --all` whenever an
`openspec/` directory exists at the repository root, and SHALL exit non-zero if any living
spec under `openspec/specs/` or any active change under `openspec/changes/` is structurally
invalid. The OpenSpec validation SHALL be a step within the `ci` npm script (alongside
`ci:core`, the `plugin/` mirror check, the install smoke test, and the launcher smoke test),
so that `.github/workflows/ci.yml` invoking `npm run ci` runs it without a separate bespoke
workflow step.

#### Scenario: invalid active change fails CI

- **WHEN** an active change under `openspec/changes/` is structurally invalid (e.g., a
  requirement is missing a `#### Scenario:`)
- **AND** `npm run ci` runs
- **THEN** the OpenSpec validation step SHALL exit non-zero
- **AND** `npm run ci` SHALL fail, blocking the PR in `.github/workflows/ci.yml`

#### Scenario: invalid living spec fails CI

- **WHEN** a living spec under `openspec/specs/` is structurally invalid
- **AND** `npm run ci` runs
- **THEN** the OpenSpec validation step SHALL exit non-zero and `npm run ci` SHALL fail

#### Scenario: valid workspace passes the OpenSpec step

- **WHEN** the entire `openspec/` workspace is structurally valid
- **AND** `npm run ci` runs
- **THEN** the OpenSpec validation step SHALL exit zero and SHALL NOT block CI

#### Scenario: a test asserts the ci script wires the OpenSpec step

- **WHEN** the `ci` npm script in `package.json` is inspected by a test
- **THEN** the test SHALL assert the chain includes the OpenSpec validation step
- **AND** the test SHALL fail if the OpenSpec validation step is removed from the `ci` chain

### Requirement: OpenSpec CI validation is conditional on an `openspec/` workspace

The OpenSpec CI validation step SHALL exit zero without invoking validation when the
repository has no `openspec/` directory, so the CI gate does not force OpenSpec onto
repositories, contexts, or installs that do not use it (including the install smoke test).
The step SHALL resolve the `openspec` CLI such that the gate runs successfully on a fresh CI
runner that does not have the CLI preinstalled.

#### Scenario: no `openspec/` directory — step is a no-op

- **WHEN** the OpenSpec validation step runs in a directory that has no `openspec/`
  workspace
- **THEN** the step SHALL exit zero
- **AND** SHALL NOT invoke `openspec validate`
- **AND** the rest of `npm run ci` SHALL be unaffected

#### Scenario: a test asserts the no-op-without-workspace behavior

- **WHEN** the OpenSpec validation step is run against a directory with no `openspec/`
  workspace in a test
- **THEN** the test SHALL assert the step exits zero without invoking validation
- **AND** the test SHALL fail if the step instead errors or attempts validation

#### Scenario: fresh runner without a preinstalled CLI still validates

- **WHEN** `npm run ci` runs on a CI runner that has no `openspec` CLI on PATH
- **AND** an `openspec/` workspace exists
- **THEN** the step SHALL resolve the CLI (e.g., via a deterministic on-demand fallback) and
  run `openspec validate --all` rather than failing with a "command not found" error

### Requirement: Build and test documentation names the OpenSpec validation gate

The repository's build/test guidance — `README.md`, `CLAUDE.md`, and `AGENTS.md` — SHALL
state that `npm run ci` validates the OpenSpec workspace (`openspec validate --all`) when an
`openspec/` directory is present, so contributors know a structurally invalid `openspec/`
fails the CI gate.

#### Scenario: README documents the OpenSpec CI gate

- **WHEN** a contributor reads the README build/test (`npm run ci`) section
- **THEN** they SHALL find that `npm run ci` includes `openspec validate --all` over the
  `openspec/` workspace

#### Scenario: CLAUDE.md and AGENTS.md document the OpenSpec CI gate

- **WHEN** a contributor reads the `Build & test` guidance in `CLAUDE.md` or `AGENTS.md`
- **THEN** they SHALL find that `npm run ci` validates the OpenSpec workspace as part of the
  required gate
