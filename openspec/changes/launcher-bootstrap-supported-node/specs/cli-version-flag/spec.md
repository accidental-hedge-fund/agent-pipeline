## ADDED Requirements

### Requirement: Version flags SHALL short-circuit on Node 18–23 without emitting the Node 24 gate

The `--version` and `-V` flags, including `--version --json`, SHALL complete on Node major 18 through 23 using only the invoking Node. They SHALL print the existing version contract from `core/package.json` (plain version string, or `{ version, commit_sha }` for `--json`) and exit 0. They SHALL NOT print `requires Node >= 24`. They SHALL NOT require a Node ≥ 24 binary to exist. This introspection SHALL NOT make Node 18–23 a supported TypeScript runtime.

#### Scenario: Host shim --version on Node 22 does not hit the engines gate

- **WHEN** `node hosts/_shared/entry.template.mjs --version` runs with `process.versions.node` `22.23.2`
- **THEN** stdout SHALL equal the `version` field of `core/package.json`
- **AND** the process SHALL exit 0
- **AND** stderr SHALL NOT contain `requires Node >= 24`

#### Scenario: Host shim -V on Node 22 does not hit the engines gate

- **WHEN** `node hosts/_shared/entry.template.mjs -V` runs with `process.versions.node` `22.23.2`
- **THEN** stdout SHALL equal the `version` field of `core/package.json`
- **AND** the process SHALL exit 0

#### Scenario: Host shim --version --json on Node 22 keeps commit_sha honest

- **WHEN** `node hosts/_shared/entry.template.mjs --version --json` runs with `process.versions.node` `22.23.2`
- **THEN** stdout SHALL be JSON with `version` equal to `core/package.json` `version`
- **AND** `commit_sha` SHALL be exact 40-hex or `null`
- **AND** the process SHALL exit 0

#### Scenario: pipeline-launcher.mjs version flags on Node 22 match the host shim

- **WHEN** `node scripts/pipeline-launcher.mjs --version`, `-V`, or `--version --json` runs with `process.versions.node` `22.23.2`
- **THEN** the stdout and exit code SHALL match the host-shim cases above
- **AND** stderr SHALL NOT contain `requires Node >= 24`

#### Scenario: Mixed argv that includes --version still short-circuits

- **WHEN** either launcher runs with argv containing `--version` or `-V` (including `status --version`) and `process.versions.node` `22.23.2`
- **THEN** the process SHALL print the version contract and exit 0
- **AND** it SHALL NOT load TypeScript
- **AND** it SHALL NOT require a Node ≥ 24 binary

#### Scenario: --json without --version or -V is not version introspection

- **WHEN** either launcher runs `path --json` with `process.versions.node` `22.23.2`
- **THEN** the process SHALL NOT treat the argv as version-only
- **AND** it SHALL re-exec onto Node ≥ 24 or fail closed
- **AND** it SHALL NOT print the `core/package.json` version as the sole stdout payload for that invocation
