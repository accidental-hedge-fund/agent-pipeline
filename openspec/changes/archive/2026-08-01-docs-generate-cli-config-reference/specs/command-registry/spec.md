## ADDED Requirements

### Requirement: The command registry surface SHALL expose documentation metadata for documented commands

The command-registry module (or a co-located companion map keyed by the same command keywords) SHALL expose documentation metadata used by the CLI reference generator. For every command keyword that appears in the generated CLI reference, the metadata SHALL include at least a human-readable `summary` and a host-token-agnostic `usage` synopsis. Keywords that remain dispatch-only (hidden or legacy aliases) SHALL be markable as undocumented so generators omit them. Adding or changing documentation metadata SHALL NOT alter dispatch routing, `allowedFlags` validation, `needsIssueNumber`, or any other runtime dispatch field.

#### Scenario: Documented command has summary and usage metadata

- **WHEN** a command keyword is included in the generated CLI reference
- **THEN** the registry documentation metadata for that keyword SHALL provide a non-empty summary and a non-empty usage synopsis

#### Scenario: Undocumented keyword can be omitted from docs

- **WHEN** a registry keyword is marked undocumented or hidden in the documentation metadata
- **THEN** the CLI reference generator SHALL be able to omit that keyword without removing it from `COMMAND_REGISTRY` dispatch

#### Scenario: Doc metadata does not change flag validation

- **WHEN** documentation metadata is added or edited for a command
- **THEN** `validateFlags` and `lookupCommand` behavior for that command SHALL remain unchanged relative to the command's runtime `CommandEntry` fields
