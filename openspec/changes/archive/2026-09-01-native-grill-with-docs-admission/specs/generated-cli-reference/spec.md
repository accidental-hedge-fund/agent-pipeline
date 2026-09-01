## ADDED Requirements

### Requirement: Generated CLI reference SHALL publish executable `grill` selector grammar from one source

Command-docs metadata and `OPERATION_SURFACE` for the `grill` registry keyword SHALL describe the executable operator grammar for `--issue N`, `--issues N,N,...`, `--milestone M`, repeated `--label L`, `--dry-run`, `status`, `--follow`, and `--resume`. Generated `docs/cli.md` and host SKILL verb tables SHALL include those forms as complete `pipeline …` usage alternatives from that same metadata. The published grammar SHALL NOT invent a second selector DSL and SHALL NOT document a host Skill tool as the operator path.

#### Scenario: docs/cli.md lists the four selector forms

- **WHEN** the CLI reference generator runs after `grill` is registered
- **THEN** `docs/cli.md` SHALL include `pipeline grill --issue`, `pipeline grill --issues`, `pipeline grill --milestone`, and `pipeline grill --label`
- **AND** SHALL include dry-run and status/follow usage

#### Scenario: Host SKILL tables match the registry grammar

- **WHEN** `node scripts/build.mjs` writes the four host SKILL files
- **THEN** each SKILL verb table SHALL list the same `grill` usage alternatives as `OPERATION_SURFACE`
- **AND** each alternative SHALL begin with `pipeline grill`
