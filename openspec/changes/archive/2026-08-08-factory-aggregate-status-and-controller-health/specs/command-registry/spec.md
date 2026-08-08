## ADDED Requirements

### Requirement: The command registry SHALL include a non-mutating factory status entry

The `COMMAND_REGISTRY` in `core/scripts/command-registry.ts` SHALL include an entry that routes
`pipeline factory status` (either as a dedicated keyword or as a documented factory subcommand
path consistent with existing `factory-gate` / `factory-pin` registration patterns) so dispatch
and allowlist-based flag validation cover it through the single authoritative registry. The
entry SHALL declare `mutatesGitHub: false` and SHALL NOT reuse advance, merge, deploy, unblock,
or override handlers. Its `allowedFlags` SHALL include the Commander attribute for `--json` and
SHALL NOT use the `"all"` sentinel.

#### Scenario: Factory status is a recognized non-mutating command

- **WHEN** the `COMMAND_REGISTRY` is inspected for the factory status command entry
- **THEN** lookup SHALL return a non-null entry
- **AND** the entry SHALL declare `mutatesGitHub: false`

#### Scenario: Unsupported flags are rejected before side effects

- **WHEN** factory status is invoked with a flag not in its `allowedFlags`
- **THEN** the CLI SHALL reject it with exit code 2 before any status assembly side effect
- **AND** rejection SHALL use the same allowlist-based validation as other registered commands

#### Scenario: `--json` is accepted

- **WHEN** `validateFlags` is called with the factory status entry and `--json` provided on the
  CLI
- **THEN** it SHALL return an empty array of offending flags

#### Scenario: Factory status is not wired to a mutating handler

- **WHEN** the factory status entry's handler is inspected
- **THEN** it SHALL NOT be the advance, merge, deploy, unblock, or override handler
