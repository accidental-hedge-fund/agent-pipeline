## ADDED Requirements

### Requirement: Discovery host enumeration SHALL use the outer-host registry for completeness

Discovery surfaces that claim to enumerate installable or known outer hosts for completeness SHALL
obtain the set of host ids from the outer-host runtime registry (or a test double of it) rather
than a hardcoded closed list of built-in host names. This applies beyond the legacy Claude/Codex
`hostCoverage` compat enum. Additive per-host objects in `pipeline path --json` (or successor
fields) SHALL be able to include a registered non-built-in host in tests without editing a
built-in-only name table as the extension path.

The existing Claude/Codex `hostCoverage` enum contract (`missing` | `claude-only` |
`codex-only` | `both`) MAY remain as a compatibility view and SHALL NOT be required to encode
every registered outer host.

#### Scenario: Registry-driven host listing includes a synthetic host

- **WHEN** a synthetic third-party outer host is registered in the outer-host registry during a
  discovery test
- **AND** discovery produces a registry-driven host listing or `hosts` map intended to reflect
  known installable hosts
- **THEN** the synthetic host id SHALL appear in that listing or map
- **AND** the test SHALL NOT require editing a hardcoded built-in-only host name table in core
  discovery source to make the host appear

#### Scenario: Legacy hostCoverage remains Claude/Codex-compatible

- **WHEN** `pipeline path --json` reports `hostCoverage`
- **THEN** the enum values SHALL continue to describe Claude and Codex reachability only under
  the existing contract
- **AND** presence of additional registered outer hosts SHALL NOT redefine those enum strings
