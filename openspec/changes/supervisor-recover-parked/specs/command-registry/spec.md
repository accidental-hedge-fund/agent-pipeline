## ADDED Requirements

### Requirement: The command registry SHALL include a recover-parked entry

The declarative command registry SHALL include a `recover-parked` command entry. The entry SHALL declare documentation metadata, require an issue (or PR→issue) number, and declare an explicit `allowedFlags` set that includes at least the standard repo/base/profile/domain allowlist members the implementation accepts and any dry-run or JSON output flags the implementation documents. The entry SHALL be classified as a mutating, non-merge command (it may record audited overrides and re-enter advance; it SHALL NOT authorize merge). Flags outside that allowlist SHALL be rejected before any recover-parked mutation. `lookupCommand("recover-parked")` SHALL return that entry.

#### Scenario: recover-parked is registered

- **WHEN** the command registry is loaded
- **THEN** it SHALL contain a `recover-parked` entry with documentation metadata
- **AND** `lookupCommand("recover-parked")` SHALL return a non-null entry

#### Scenario: Disallowed flags on recover-parked are rejected

- **WHEN** an operator runs `pipeline recover-parked` with a flag not on the recover-parked allowlist
- **THEN** the CLI SHALL exit with code 2 naming the offending flag
- **AND** no recover-parked mutation SHALL occur

#### Scenario: recover-parked is not a merge command

- **WHEN** the registry metadata for `recover-parked` is inspected
- **THEN** the entry SHALL NOT be documented or classified as a merge-authorizing command
- **AND** invoking it SHALL NOT call the merge or merge-queue apply path
