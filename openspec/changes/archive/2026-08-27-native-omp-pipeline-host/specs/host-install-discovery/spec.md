## ADDED Requirements

### Requirement: pipeline path discovery SHALL preserve Claude/Codex hostCoverage contract when OMP is present

The `pipeline path` / `pipeline path --json` `hostCoverage` enum SHALL continue to describe Claude and Codex CLI/host reachability only (`missing` | `claude-only` | `codex-only` | `both`), whether or not OMP is installed. Presence or absence of an OMP skill install SHALL NOT change the meaning of those enum values or cause a probe error solely because OMP exists.

#### Scenario: OMP install does not flip Claude/Codex hostCoverage meaning

- **WHEN** Claude and Codex are both reachable and OMP is also installed
- **AND** `pipeline path --json` is invoked
- **THEN** `hostCoverage` SHALL remain `"both"` under the existing Claude/Codex contract
- **AND** the command SHALL exit 0

#### Scenario: OMP-only skill does not invent a false Claude/Codex coverage

- **WHEN** neither Claude nor Codex is reachable as defined by the existing discovery probe
- **AND** an OMP managed skill install exists
- **AND** `pipeline path --json` is invoked
- **THEN** `hostCoverage` SHALL remain `"missing"` under the existing Claude/Codex contract
- **AND** the command SHALL exit 0

### Requirement: pipeline path JSON SHALL report OMP presence additively

The `pipeline path --json` output SHALL report OMP via an additive `hosts.omp` object (at minimum `available: boolean`) without removing or redefining the existing `hosts.claude`, `hosts.codex`, and `hosts.opencode` keys.

#### Scenario: Additive OMP host key when OMP is installed

- **WHEN** an OMP managed skill install exists
- **AND** `pipeline path --json` is invoked
- **THEN** the JSON SHALL include `hosts.omp.available` equal to `true`
- **AND** SHALL still include `hosts.claude` and `hosts.codex` objects

#### Scenario: Additive OMP host key when OMP is absent

- **WHEN** no OMP skill install is present
- **AND** `pipeline path --json` is invoked
- **THEN** `hosts.omp.available` SHALL be `false`
- **AND** Claude/Codex fields SHALL remain valid
