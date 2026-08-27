# host-install-discovery Specification

## Purpose
TBD - created by archiving change desktop-contract-host-neutral-launcher. Update Purpose after archive.

## Requirements

### Requirement: pipeline path reports install state and host coverage
The CLI SHALL expose a `pipeline path` subcommand that probes known install locations, determines host coverage, and prints the result. Without flags, the output SHALL be human-readable. With `--json`, the output SHALL be a machine-readable JSON object. The subcommand SHALL exit with code 0 for any resolved state (including missing install) and non-zero only on a probe error.

#### Scenario: Both hosts installed — human-readable output
- **WHEN** `pipeline path` is invoked and both the `claude` and `codex` CLIs are reachable
- **THEN** the command SHALL print the resolved core path, version string, and a line indicating `hostCoverage: both`
- **AND** SHALL exit with code 0

#### Scenario: Claude-only install — JSON output
- **WHEN** `pipeline path --json` is invoked and `claude` is reachable but `codex` is not
- **THEN** the command SHALL print valid JSON containing `{ "hostCoverage": "claude-only", "corePath": "<path>", "version": "<version>", "hosts": { "claude": { "available": true }, "codex": { "available": false } } }`
- **AND** SHALL exit with code 0

#### Scenario: Codex-only install — JSON output
- **WHEN** `pipeline path --json` is invoked and `codex` is reachable but `claude` is not
- **THEN** `hostCoverage` in the JSON SHALL be `"codex-only"`

#### Scenario: Missing install — JSON output
- **WHEN** `pipeline path --json` is invoked and neither `claude` nor `codex` is reachable
- **THEN** `hostCoverage` in the JSON SHALL be `"missing"`
- **AND** the command SHALL exit with code 0 (not an error exit — the caller inspects the field)

#### Scenario: Probe error exits non-zero
- **WHEN** the install-location probe itself fails (e.g., `npm root -g` is unavailable)
- **THEN** the command SHALL exit with a non-zero exit code and print a diagnostic to stderr

#### Scenario: Discovery works without provisioned runtime dependencies
- **WHEN** `pipeline path --json` is invoked but the package's runtime dependencies (`core/node_modules`) are absent OR present-but-incomplete because best-effort install-time provisioning could not complete (e.g. offline, transient registry failure, a partial `npm ci`, or a read-only global package directory)
- **THEN** the command SHALL still print valid discovery JSON and exit 0 (it SHALL NOT depend on the full CLI's third-party dependencies and SHALL NOT attempt to write into the package directory)
- **AND** a command that requires the engine (e.g. `pipeline run`) MAY instead exit non-zero with a re-install hint

### Requirement: JSON output schema for pipeline path --json
The `--json` output SHALL conform to a stable schema so that callers need not parse prose. The schema SHALL include `corePath` (string | null), `version` (string | null), `hostCoverage` (one of `"missing"` | `"claude-only"` | `"codex-only"` | `"both"`), and `hosts` (an object with `claude` and `codex` keys, each containing `available` (boolean) and `cliBin` (string | null)).

#### Scenario: Full both-hosts JSON structure
- **WHEN** `pipeline path --json` is invoked with both hosts installed
- **THEN** the output SHALL be valid JSON matching:
  `{ "corePath": "<string>", "version": "<semver>", "hostCoverage": "both", "hosts": { "claude": { "available": true, "cliBin": "<string>" }, "codex": { "available": true, "cliBin": "<string>" } } }`

#### Scenario: Missing-install JSON structure
- **WHEN** `pipeline path --json` is invoked with no hosts installed
- **THEN** `corePath` and `version` SHALL be `null` and `hostCoverage` SHALL be `"missing"`

### Requirement: pipeline --version is unaffected
The existing `pipeline --version` behavior (print version, exit 0, no harness invocation required) SHALL remain unchanged. `pipeline path` is an additive subcommand and SHALL NOT alter the `--version` flag contract.

#### Scenario: --version still works with no hosts installed
- **WHEN** `pipeline --version` is invoked regardless of host availability
- **THEN** the CLI SHALL print the version string and exit with code 0

### Requirement: README documents the desktop-safe launch and discovery path
The README SHALL include a section that documents (a) how to launch a detached run via `pipeline run <issue> --detach [--timeout <seconds>]`, (b) how to poll for completion using `sentinel.json`, and (c) how to discover installed hosts via `pipeline path --json`, with an example of interpreting each `hostCoverage` value.

#### Scenario: Desktop integrator can follow README without reading source
- **WHEN** a developer follows only the README desktop-integration section
- **THEN** they SHALL have sufficient information to launch a detached run and interpret the completion sentinel and host-discovery output

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
