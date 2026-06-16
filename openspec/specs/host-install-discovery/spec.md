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

