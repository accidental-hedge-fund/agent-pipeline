## ADDED Requirements

### Requirement: The command registry SHALL include a non-mutating correction entry

The `COMMAND_REGISTRY` in `core/scripts/command-registry.ts` SHALL include an entry for the
`correction` command keyword so that dispatch routing and allowlist-based flag validation cover
it through the single authoritative registry, without a per-command conflict list elsewhere.
The `correction` entry SHALL declare `mutatesGitHub: false` (its only side effect is appending
one `correction_event`), and its declared `allowedFlags` SHALL be limited to the flags the
`correction record` action needs. The entry SHALL NOT reuse the advance, unblock, override,
merge, or deploy handlers.

#### Scenario: correction is a recognized command keyword

- **WHEN** the `COMMAND_REGISTRY` is inspected
- **THEN** `lookupCommand("correction")` SHALL return a non-null entry
- **AND** the entry SHALL declare `mutatesGitHub: false`

#### Scenario: correction flag validation runs through the registry

- **WHEN** the `correction` command is invoked with a flag not in its `allowedFlags`
- **THEN** the CLI SHALL reject it with exit code 2 before any side effect, via the same allowlist-based validation used for every other registered command

#### Scenario: correction entry is not wired to a mutating handler

- **WHEN** the `correction` entry's handler is inspected
- **THEN** it SHALL NOT be the advance, unblock, override, merge, or deploy handler
