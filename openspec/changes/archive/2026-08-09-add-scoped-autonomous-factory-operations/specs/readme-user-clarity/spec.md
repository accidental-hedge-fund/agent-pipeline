## MODIFIED Requirements

### Requirement: All instructions are accurate to current tool behavior

Every instruction, command, flag, and description in the README and in the linked authoritative operator docs (`docs/cli.md`, `docs/config.md`, and `docs/concepts.md`) SHALL reflect current behavior. No step SHALL contradict the installer, Pipeline commands, reviewer wiring, configuration schema, release path, or deployment boundary. The README SHALL distinguish ordinary stop-at-ready behavior from a disabled-by-default scoped external factory. It SHALL NOT imply that the scoped factory is a Pipeline config key, a merge stage, or a default capability.

#### Scenario: Install commands match installer implementation

- **WHEN** a reader runs an install command shown in the README
- **THEN** the command SHALL execute against the current installer with valid flags, environment names, and host names

#### Scenario: Reviewer wiring description matches default behavior

- **WHEN** the README or `docs/concepts.md` describes review invocation
- **THEN** it SHALL accurately describe the configured prompt-harness path
- **AND** it SHALL NOT present removed companion modes as valid alternatives

#### Scenario: Config key examples are valid

- **WHEN** the README or `docs/config.md` shows a `.github/pipeline.yml` block
- **THEN** every key shown SHALL be recognized by the current schema
- **AND** no schema-rejected key such as `auto_merge` or a deployment grant SHALL appear as supported configuration

#### Scenario: Default and scoped factory behavior are distinct

- **WHEN** the README describes Hermes completing merges and a release
- **THEN** it SHALL first state that normal advance and loop commands stop at `pipeline:ready-to-deploy`
- **AND** it SHALL identify the Hermes factory as an external, opt-in, disabled-by-default deployment that requires a separate authenticated grant
- **AND** it SHALL link the exact trust boundary and runbook
