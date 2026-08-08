## ADDED Requirements

### Requirement: Generated CLI and host docs SHALL document factory status

When the CLI reference generator and host SKILL command-table generators run against a registry that includes the factory status command as a documented entry, `docs/cli.md` and the host SKILL generated regions SHALL include factory status usage (including `--json`) with the host's invocation token. The generator SHALL NOT invent factory status if it is absent from the registry, and SHALL NOT document it as a mutating command.

#### Scenario: Documented factory status appears in docs/cli.md

- **WHEN** the CLI reference generator runs after factory status is registered as documented
- **THEN** `docs/cli.md` SHALL contain a usage synopsis that includes factory status and
  `--json`

#### Scenario: Host SKILL tables list factory status

- **WHEN** the host SKILL command-table regions are regenerated for Claude and Codex
- **THEN** both regions SHALL list factory status among documented commands
- **AND** each region SHALL use only that host's invocation token form
