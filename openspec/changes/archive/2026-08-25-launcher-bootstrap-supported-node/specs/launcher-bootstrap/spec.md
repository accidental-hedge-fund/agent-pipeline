## Purpose

Launcher bootstrap is the dependency-free phase before loading TypeScript. It answers version-only requests on the invoking Node and otherwise resolves and re-execs an engines-compliant Node so a still-supported PATH major below the engine floor does not block the CLI.

## ADDED Requirements

### Requirement: Version-only argv SHALL run on Node 18–23 without an engines-compliant Node

The host shim generated from `hosts/_shared/entry.template.mjs` and `scripts/pipeline-launcher.mjs` SHALL treat `--version`, `-V`, and `--version --json` as introspection-only. On Node major 18 through 23 they SHALL print the existing version contract and exit 0. They SHALL NOT print `requires Node >= 24`. They SHALL NOT require a Node ≥ 24 binary to exist. They SHALL NOT load TypeScript.

#### Scenario: --version on Node 22.23.2 prints the package version

- **WHEN** `node hosts/_shared/entry.template.mjs --version` runs with `process.versions.node` `22.23.2` and no Node ≥ 24 binary on the machine
- **THEN** stdout SHALL equal the `version` field of `core/package.json`
- **AND** the process SHALL exit 0
- **AND** stderr SHALL NOT contain `requires Node >= 24`

#### Scenario: -V on Node 22.23.2 matches --version

- **WHEN** `node hosts/_shared/entry.template.mjs -V` runs with `process.versions.node` `22.23.2`
- **THEN** stdout SHALL equal the `version` field of `core/package.json`
- **AND** the process SHALL exit 0
- **AND** stderr SHALL NOT contain `requires Node >= 24`

#### Scenario: --version --json on Node 18–23 keeps the commit_sha contract

- **WHEN** `node hosts/_shared/entry.template.mjs --version --json` runs with Node major 18 through 23
- **THEN** stdout SHALL be JSON `{ version, commit_sha }`
- **AND** `version` SHALL equal the `version` field of `core/package.json`
- **AND** `commit_sha` SHALL be an exact 40-hex SHA or `null`
- **AND** `commit_sha` SHALL NOT be invented
- **AND** the process SHALL exit 0

#### Scenario: pipeline-launcher.mjs version flags match the host shim

- **WHEN** `node scripts/pipeline-launcher.mjs --version`, `-V`, or `--version --json` runs with Node major 18 through 23
- **THEN** the stdout, exit code, and `requires Node >= 24` absence SHALL match the host-shim cases above

#### Scenario: Mixed argv that includes --version still short-circuits on Node 22

- **WHEN** either launcher runs with argv containing `--version` or `-V` (including `status --version`) and `process.versions.node` `22.23.2`
- **THEN** the process SHALL print the version contract and exit 0
- **AND** it SHALL NOT load TypeScript
- **AND** it SHALL NOT require a Node ≥ 24 binary

#### Scenario: --json without --version or -V is not version introspection

- **WHEN** either launcher runs `path --json` with `process.versions.node` `22.23.2`
- **THEN** the process SHALL NOT treat the argv as version-only
- **AND** it SHALL re-exec onto Node ≥ 24 or fail closed

### Requirement: TypeScript-loading argv SHALL re-exec onto a resolved Node ≥ 24 binary

Every command that loads TypeScript — including `status`, `train`, `path`, `path --json`, and a bare invoke — SHALL resolve a Node binary whose major is ≥ 24 and re-exec onto that binary before loading the TypeScript core. This SHALL apply to every invoking Node major below 24, including 18 and 20, not only 22. The re-exec SHALL spawn the resolved absolute binary with argv equal to the script path plus the original user args in order. The child environment SHALL prepend that binary's directory to `PATH` and SHALL NOT replace `PATH`. The launcher SHALL propagate the child numeric exit status, re-send a child signal when the child is killed by a signal, and fail closed on spawn failure without loading TypeScript. Node 18–23 introspection SHALL NOT extend to TypeScript execution. TypeScript SHALL NOT load on the parent process.

#### Scenario: status on Node 22 re-execs a fake Node 24 with argv preserved

- **WHEN** the host shim runs as `status` with `process.versions.node` `22.23.2`
- **AND** a Node ≥ 24 binary is resolvable (including a test fake on `PATH` or `AGENT_PIPELINE_NODE`)
- **THEN** the shim SHALL re-exec that ≥ 24 binary
- **AND** the child argv SHALL include the original `status` token
- **AND** the shim SHALL NOT exit 1 with `requires Node >= 24` instead of re-execing

#### Scenario: train on Node 22 re-execs with argv preserved

- **WHEN** the host shim runs as `train --milestone data-integrity` with `process.versions.node` `22.23.2`
- **AND** a Node ≥ 24 binary is resolvable
- **THEN** the re-exec child argv SHALL preserve `train` and `--milestone` `data-integrity` in order
- **AND** the child's `PATH` SHALL start with that binary's directory

#### Scenario: path is a TypeScript-loading route and re-execs

- **WHEN** `path` or `path --json` runs with Node major 22 and a resolvable Node ≥ 24 binary
- **THEN** the launcher SHALL re-exec onto that binary before spawning `path-cli.ts`
- **AND** it SHALL NOT load TypeScript on the Node 22 process

#### Scenario: path --json re-execs before path-cli.ts

- **WHEN** `path --json` runs with Node major 22 and a resolvable Node ≥ 24 binary
- **THEN** the launcher SHALL re-exec onto that binary before spawning `path-cli.ts`
- **AND** the child argv SHALL preserve `path` and `--json` in order
- **AND** it SHALL NOT load TypeScript on the Node 22 process

#### Scenario: Node 18 and Node 20 TypeScript routes also re-exec or fail closed

- **WHEN** a TypeScript-loading command runs with `process.versions.node` major 18 or 20
- **AND** a Node ≥ 24 binary is resolvable
- **THEN** the launcher SHALL re-exec onto that binary before loading TypeScript
- **AND** if no such binary exists, it SHALL fail closed without loading TypeScript

#### Scenario: Child PATH is prepended, not replaced

- **WHEN** re-exec spawns a resolved Node ≥ 24 binary
- **THEN** the child `PATH` SHALL start with that binary's directory
- **AND** the remainder of the parent `PATH` SHALL still be present after that directory

#### Scenario: pipeline-launcher.mjs TypeScript routes match the host shim

- **WHEN** `scripts/pipeline-launcher.mjs` runs `status` or `train` with `process.versions.node` `22.23.2` and a resolvable Node ≥ 24 binary
- **THEN** it SHALL re-exec that binary with argv preserved the same way as the host shim

### Requirement: Node resolution SHALL use ensure-engines-node.mjs as the sole walker

Launcher re-exec SHALL call `resolveEnginesNode` / `envPreferringNode` from `scripts/ensure-engines-node.mjs`, honoring `AGENT_PIPELINE_NODE`. The launchers SHALL NOT contain a second candidate walker (a duplicated `/usr/bin/node` / `PATH` / home-dir probe list).

#### Scenario: AGENT_PIPELINE_NODE wins when it satisfies the floor

- **WHEN** PATH `node` is major 22
- **AND** `AGENT_PIPELINE_NODE` points at a Node ≥ 24 binary
- **THEN** re-exec SHALL use that `AGENT_PIPELINE_NODE` path

#### Scenario: /usr/bin/node 24 is used when PATH node is 22

- **WHEN** PATH `node` is `22.23.2`
- **AND** `/usr/bin/node` reports major ≥ 24
- **AND** `AGENT_PIPELINE_NODE` is unset
- **THEN** re-exec SHALL use `/usr/bin/node` (or another resolver candidate of major ≥ 24)
- **AND** the process SHALL NOT tell the operator to `nvm install 24`

#### Scenario: Launchers do not duplicate the resolver candidate list

- **WHEN** `hosts/_shared/entry.template.mjs` and `scripts/pipeline-launcher.mjs` are inspected
- **THEN** they SHALL import or otherwise invoke `scripts/ensure-engines-node.mjs` for Node resolution
- **AND** they SHALL NOT embed a second copy of that module's candidate probe list

### Requirement: Missing engines-compliant Node SHALL fail closed with a named diagnostic

A TypeScript-loading command SHALL fail closed only when no engines-compliant Node can be resolved. The diagnostic SHALL be produced by `formatMissingEnginesNodeDiagnostic` in `scripts/ensure-engines-node.mjs` (or an equivalent export from that same module). It SHALL name the found `process.versions.node`, `/usr/bin/node`, and `AGENT_PIPELINE_NODE` without a second probe list in the launchers. The diagnostic SHALL NOT tell the operator to `nvm install 24` when a ≥ 24 binary is already on the box. The launchers SHALL NOT probe `/usr/bin/node` or `AGENT_PIPELINE_NODE` themselves to build this text.

#### Scenario: No ≥ 24 binary names all three sources

- **WHEN** a TypeScript-loading command runs with `process.versions.node` `22.23.2`
- **AND** no Node ≥ 24 binary can be resolved
- **THEN** the process SHALL exit non-zero
- **AND** the diagnostic SHALL include `process.versions.node` `22.23.2`
- **AND** the diagnostic SHALL name `/usr/bin/node`
- **AND** the diagnostic SHALL name `AGENT_PIPELINE_NODE`
- **AND** TypeScript SHALL NOT load

#### Scenario: ≥ 24 already on the box is not an nvm-install failure

- **WHEN** PATH `node` is major 22
- **AND** `/usr/bin/node` or `AGENT_PIPELINE_NODE` is a Node ≥ 24 binary
- **THEN** the launcher SHALL re-exec that binary
- **AND** it SHALL NOT print `nvm install 24` as the outcome

### Requirement: Installer and plugin mirror SHALL stage ensure-engines-node.mjs next to the shim

`scripts/install.mjs` and `scripts/build.mjs` SHALL copy `scripts/ensure-engines-node.mjs` into the skill `scripts/` directory next to the generated `pipeline.mjs` so an installed skill tree (`…/skills/pipeline/scripts/`) and the generated `plugin/` tree can resolve the module the shim loads. Regenerated `plugin/` SHALL ship in the same change as the staging logic.

#### Scenario: Installed skill tree can resolve the resolver module

- **WHEN** the installer stages a host skill tree
- **THEN** `…/skills/pipeline/scripts/ensure-engines-node.mjs` SHALL exist
- **AND** the generated `pipeline.mjs` in that same directory SHALL be able to load it

#### Scenario: plugin/ mirror stages the resolver module

- **WHEN** `node scripts/build.mjs` generates the plugin tree
- **THEN** `plugin/pipeline/skills/pipeline/scripts/ensure-engines-node.mjs` SHALL exist next to `pipeline.mjs`

#### Scenario: Repo template --version still works without the installed layout

- **WHEN** `node hosts/_shared/entry.template.mjs --version` runs from the repository (not an installed skill tree)
- **THEN** it SHALL still print the package version and exit 0
- **AND** it SHALL NOT fail module load solely because `ensure-engines-node.mjs` is not a sibling of the template

### Requirement: Root and core engines.node SHALL remain >=24

This change SHALL NOT lower root or `core/` `engines.node` below `>=24`. Packaging-coherence SHALL keep failing a root floor that admits majors below 24. The TypeScript engine SHALL NOT run on Node 22.

#### Scenario: engines.node floors stay >=24

- **WHEN** root `package.json` and `core/package.json` are read after this change
- **THEN** both `engines.node` values SHALL be ranges that do not admit Node major versions below 24

#### Scenario: TypeScript core is not executed on Node 22

- **WHEN** a TypeScript-loading command is invoked with Node major 22
- **THEN** `pipeline.ts` / `path-cli.ts` SHALL run only after re-exec onto Node ≥ 24
- **OR** the command SHALL fail closed when no such binary exists

### Requirement: Bootstrap regressions SHALL be caught by tests that inject Node 22

Regression tests SHALL fail if the host shim or `scripts/pipeline-launcher.mjs` prints the Node 24 gate for `--version` / `-V` when `process.versions.node` is `22.23.2`. They SHALL fail if those launchers, with Node 22 and a fake Node 24 on PATH, exit the gate for `status` / `train` instead of re-execing that 24 binary with argv preserved. They SHALL fail if those launchers, with Node 22 and no ≥ 24 binary, omit `AGENT_PIPELINE_NODE` from the failure. Tests SHALL inject node version, resolver, and spawn so they do not require a live Node 22 CI image. Tests SHALL NOT use real network or git.

#### Scenario: --version gate on 22.23.2 is a failing test without the fix

- **WHEN** the version bootstrap test runs with injected `process.versions.node` `22.23.2`
- **AND** the launcher still exits the Node ≥ 24 gate before the version short-circuit
- **THEN** the test SHALL fail

#### Scenario: status/train skip-reexec on 22 is a failing test without the fix

- **WHEN** the re-exec test runs with injected Node 22 and a fake Node 24 resolver hit
- **AND** the launcher exits the gate instead of spawning that 24 binary with preserved argv
- **THEN** the test SHALL fail

#### Scenario: fail-closed omitting AGENT_PIPELINE_NODE is a failing test without the fix

- **WHEN** the fail-closed test runs with injected Node 22 and a resolver miss
- **AND** the diagnostic does not name `AGENT_PIPELINE_NODE`
- **THEN** the test SHALL fail

#### Scenario: Both launchers are covered

- **WHEN** the regression suite runs
- **THEN** the three cases SHALL apply to `hosts/_shared/entry.template.mjs` and to `scripts/pipeline-launcher.mjs`
