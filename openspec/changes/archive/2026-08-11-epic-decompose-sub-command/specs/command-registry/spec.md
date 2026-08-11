## ADDED Requirements

### Requirement: The command registry SHALL include a `decompose` entry

The `COMMAND_REGISTRY` SHALL include a `decompose` keyword entry. That entry SHALL declare `needsIssueNumber: false`, `mutatesGitHub: true` (writes occur only when the handler is invoked with `--apply`; dry-run performs no GitHub mutations), `needsConfig: true`, `needsGhAuth: true`, and an `allowedFlags` set that includes at minimum the option attribute names for epic selection, optional description seed, apply, release pin, max-children, max-effort, and any documented sizing override flags used by the command. `lookupCommand("decompose")` SHALL return that entry.

#### Scenario: Decompose registry entry is present

- **WHEN** the `COMMAND_REGISTRY` is inspected
- **THEN** `lookupCommand("decompose")` SHALL return a non-null entry
- **AND** that entry SHALL declare `needsIssueNumber: false`

#### Scenario: Unsupported flag on decompose is rejected

- **WHEN** the user invokes `pipeline decompose` with an explicitly provided option not in the decompose `allowedFlags` set
- **THEN** the CLI SHALL exit with code 2 naming the unsupported flag(s) before config resolution or GitHub writes
