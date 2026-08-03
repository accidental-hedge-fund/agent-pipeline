## ADDED Requirements

### Requirement: pipeline path discovery SHALL preserve Claude/Codex hostCoverage contract when OpenCode is present

The `pipeline path` / `pipeline path --json` `hostCoverage` enum SHALL continue
to describe Claude and Codex CLI/host reachability only (`missing` |
`claude-only` | `codex-only` | `both`), whether or not OpenCode is installed.
Presence or absence of an OpenCode skill install SHALL NOT change the meaning
of those enum values or cause a probe error solely because OpenCode exists.

#### Scenario: OpenCode install does not flip Claude/Codex hostCoverage meaning

- **WHEN** Claude and Codex are both reachable and OpenCode is also installed
- **AND** `pipeline path --json` is invoked
- **THEN** `hostCoverage` SHALL remain `"both"` under the existing Claude/Codex
  contract
- **AND** the command SHALL exit 0

#### Scenario: OpenCode-only skill does not invent a false Claude/Codex coverage

- **WHEN** neither Claude nor Codex is reachable as defined by the existing
  discovery probe
- **AND** an OpenCode managed skill install exists
- **AND** `pipeline path --json` is invoked
- **THEN** `hostCoverage` SHALL remain `"missing"` under the existing
  Claude/Codex contract
- **AND** the command SHALL exit 0

### Requirement: pipeline path JSON MAY report OpenCode presence additively

The `pipeline path --json` output SHALL report OpenCode only via an additive
`hosts.opencode` object (at minimum `available: boolean`) when discovery is
extended for OpenCode, without removing or redefining the existing
`hosts.claude` and `hosts.codex` keys. Implementations that do not extend
discovery yet SHALL leave OpenCode unreported while still satisfying the
preserve-contract requirement above.

#### Scenario: Additive OpenCode host key when discovery is extended

- **WHEN** discovery is extended to report OpenCode
- **AND** an OpenCode managed skill install exists
- **AND** `pipeline path --json` is invoked
- **THEN** the JSON SHALL include `hosts.opencode.available` equal to `true`
- **AND** SHALL still include `hosts.claude` and `hosts.codex` objects

#### Scenario: Additive OpenCode host key when OpenCode is absent

- **WHEN** discovery is extended to report OpenCode
- **AND** no OpenCode skill install is present
- **AND** `pipeline path --json` is invoked
- **THEN** `hosts.opencode.available` SHALL be `false` (or the key omitted only
  if the implementation documents that OpenCode reporting is not yet wired)
- **AND** Claude/Codex fields SHALL remain valid
