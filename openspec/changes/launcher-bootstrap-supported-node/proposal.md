## Why

The shared launchers treat PATH `node` as the engine runtime and exit on major < 24 before any command runs. On 2026-08-24 an OMP `$pipeline --version` / `$pipeline train --milestone data-integrity` invoke used PATH Node 22.23.2 (`~/.local/bin/node` → Hermes) while `/usr/bin/node` on the same box was 24.18.0. The shim printed `requires Node >= 24 for native TypeScript execution (found 22.23.2)` and never wrote `1.39.12` or started train. `--version` only reads `core/package.json` and does not load TypeScript. `scripts/ensure-engines-node.mjs` already walks that layout for `npm run ci`; the launchers do not.

This is a class defect, not an OMP mole. Every host whose PATH `node` is a still-supported major below the engine floor (today: Node 22 LTS) fails the same way. Node 20 is EOL. The TypeScript engine floor stays `engines.node: ">=24"`.

## What Changes

- **Introspection-only Node 18–23 compatibility.** `--version`, `-V`, and `--version --json` SHALL run on the invoking Node without an engines-compliant binary. They SHALL NOT print `requires Node >= 24`.
- **Re-exec onto Node ≥ 24 for every TypeScript-loading route** (`status`, `train`, `path`, `path --json`, bare invoke, …) on **any** invoking major `< 24` (including 18 and 20). Resolution SHALL reuse `scripts/ensure-engines-node.mjs` (`resolveEnginesNode` / `envPreferringNode` / `AGENT_PIPELINE_NODE`). The child's `PATH` SHALL prepend that binary's directory (not replace `PATH`). Child argv SHALL be the script path plus original user args in order. Child `process.execPath` SHALL be the selected Node.
- **Fail closed only when no engines-compliant Node can be resolved.** The diagnostic SHALL name `process.versions.node`, `/usr/bin/node`, and `AGENT_PIPELINE_NODE`. It SHALL NOT tell the operator to `nvm install 24` when a ≥24 binary is already on the box.
- **Installer / `scripts/build.mjs` SHALL stage `ensure-engines-node.mjs`** next to the generated shim so an installed skill tree (`…/skills/pipeline/scripts/`) can resolve it. Regenerated `plugin/` belongs in the same change.
- Root and `core/` `engines.node` SHALL remain `>=24`. Packaging-coherence SHALL keep refusing a root floor that admits majors below 24. This change does not run the TypeScript engine on Node 22.

**BREAKING:** none. Operators already on Node ≥ 24 see the same engine. Operators on Node 22 with a ≥24 binary on the machine start working.

Non-goals: pinning a Node 24 absolute path into generated host command templates; adding an OMP / Oh My Pi outer host (sibling #1235); changing PATH on operator machines; lowering `engines.node`; compiling the TypeScript core to JS; supporting EOL Node (20 and below) as an engine runtime.

## Acceptance criteria

- [ ] On Node major 18–23, `node hosts/_shared/entry.template.mjs --version` and `-V` print the `core/package.json` version to stdout and exit 0. They do not print `requires Node >= 24`. They do not require a Node ≥ 24 binary to exist.
- [ ] `node hosts/_shared/entry.template.mjs --version --json` on Node 18–23 emits `{ version, commit_sha }` with `commit_sha` exact 40-hex or null (never invented).
- [ ] The same three `--version` / `-V` / `--version --json` cases hold for `scripts/pipeline-launcher.mjs`.
- [ ] A TypeScript-loading command (`status`, `train`, `path`, `path --json`, bare invoke) invoked with any Node major below 24 (including 18, 20, and 22) re-execs onto a resolved Node ≥ 24 binary, preserves argv as `[scriptPath, ...userArgs]`, and prepends that binary's directory on the child's `PATH`. Resolution uses `scripts/ensure-engines-node.mjs` (`resolveEnginesNode` / `envPreferringNode` / `AGENT_PIPELINE_NODE`), not a second walker.
- [ ] The same command fails closed only when no engines-compliant Node can be resolved. The diagnostic names the found `process.versions.node`, `/usr/bin/node`, and `AGENT_PIPELINE_NODE`. It does not tell the operator to `nvm install 24` when a ≥24 binary is already on the box.
- [ ] Root and `core/` `engines.node` remain `>=24`. Packaging-coherence still fails a root floor that admits majors below 24. The TypeScript engine does not run on Node 22.
- [ ] The installer and `scripts/build.mjs` stage `ensure-engines-node.mjs` so an installed skill tree (`…/skills/pipeline/scripts/`) can resolve the module the shim imports. Regenerated `plugin/` is in the same change.
- [ ] A regression test fails if the shim prints the Node 24 gate for `--version` / `-V` when `process.versions.node` is `22.23.2`.
- [ ] A regression test fails if the shim, running under Node 22 with a fake Node 24 on PATH, exits the gate for `status` / `train` instead of re-execing that 24 binary with argv preserved.
- [ ] A regression test fails if the shim, running under Node 22 with no ≥24 binary, omits `AGENT_PIPELINE_NODE` from the failure.
- [ ] The same three regression cases cover `scripts/pipeline-launcher.mjs`.
- [ ] After any `core/` or `hosts/_shared/` edit, `node scripts/build.mjs` runs in the same change. `npm run ci` is green.

## Capabilities

### New Capabilities

- `launcher-bootstrap`: Dependency-free launcher phase before loading TypeScript. Version-only argv is introspection-compatible on Node 18–23. Every TypeScript-loading route resolves and re-execs Node ≥ 24 via `ensure-engines-node.mjs`. Fail-closed diagnostics name the probed sources. The installer and plugin mirror stage that resolver next to the shim.

### Modified Capabilities

- `cli-version-flag`: `--version` / `-V` / `--version --json` SHALL short-circuit on Node 18–23 without an engines-compliant Node and SHALL NOT emit the Node ≥ 24 gate.

## Impact

- **Launchers:** `hosts/_shared/entry.template.mjs` (generated host `pipeline.mjs`) and `scripts/pipeline-launcher.mjs`. Move the Node ≥ 24 gate after the version short-circuit. On remaining argv, re-exec via the shared resolver instead of exiting.
- **Resolver (sole walker):** `scripts/ensure-engines-node.mjs` (`resolveEnginesNode`, `envPreferringNode`, `AGENT_PIPELINE_NODE`). No second candidate walker in the shims.
- **Staging:** `scripts/install.mjs` copies `ensure-engines-node.mjs` into the skill `scripts/` directory. `scripts/build.mjs` stages the same file into `plugin/pipeline/skills/pipeline/scripts/` so the generated shim can import it.
- **Engines floor unchanged:** root and `core/package.json` `engines.node` stay `>=24`. `scripts/packaging-coherence.mjs` stays a fail for a looser root floor.
- **Tests:** injectable bootstrap tests covering version-on-22, re-exec-on-22-with-fake-24, fail-closed naming `AGENT_PIPELINE_NODE`, for both launchers. Existing `scripts/ensure-engines-node.test.mjs` remains the resolver suite. No real network or git.
- **Does not:** add `hosts/omp` (#1235); pin Node 24 into OpenCode/SKILL.md templates; lower `engines.node`; compile `pipeline.ts` to JS; treat Node 20 as an engine runtime; merge inside advance/loop.
- **Class vs site:** the site is one OMP PATH-22 box. The class is launcher bootstrap that refuses a supported PATH major when an engines-compliant binary is already installed. The next host with PATH Node 22 and `/usr/bin/node` 24 uses the same bootstrap and does not need a new mole issue.
