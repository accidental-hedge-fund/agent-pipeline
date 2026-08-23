## Purpose

Install the pipeline CLI for Claude the same way as Codex and Grok: launcher plus `core/node_modules`, with a SKILL that execs `pipeline <verb>`. Do not vendor engine source into `plugin/` and do not emit a `/pipeline:*` command pack.

## ADDED Requirements

### Requirement: Claude install SHALL provision the pipeline CLI

`install --host claude` (not dry-run) SHALL provision the pipeline CLI under the resolved Claude skill install: a launcher and a `core/` tree whose runtime dependencies are installed at `core/node_modules` (or the documented first-run self-heal path if `npm ci` cannot complete). Claude SHALL get the engine the same way as Codex and Grok. The installer SHALL also install the Claude host SKILL overlay. That SKILL SHALL instruct the agent to exec `pipeline <verb>`. Short SKILL prose is owned by #1049; this requirement is satisfied by pointing install at the current host SKILL overlay. Dry-run SHALL NOT write the skill tree.

#### Scenario: Claude install writes launcher and core runtime

- **WHEN** `install --host claude` completes successfully (not dry-run)
- **THEN** the Claude skill install SHALL contain a launcher that dispatches the pipeline CLI
- **AND** SHALL contain a `core/` tree with runtime dependencies provisioned at `core/node_modules` (or the documented self-heal path)
- **AND** SHALL contain the Claude host SKILL overlay

#### Scenario: Installed launcher accepts doctor and status

- **WHEN** `install --host claude` has completed
- **AND** the installed launcher is invoked as `doctor`
- **THEN** the CLI SHALL dispatch the doctor verb (preflight). It SHALL NOT fail because a slash-command file is missing
- **AND** when invoked as `status <N>` it SHALL dispatch the status verb. It SHALL NOT fail because a slash-command file is missing

#### Scenario: Dry-run writes no Claude skill tree

- **WHEN** `install --host claude --dry-run` runs
- **THEN** the installer SHALL NOT create or replace the Claude skill install tree

### Requirement: Build SHALL NOT vendor core engine source into plugin/

`scripts/build.mjs` SHALL NOT copy `core/scripts` or any other engine source under `core/` into `plugin/`. After a successful generate run, no path matching `plugin/**/core/scripts/pipeline.ts` SHALL have been written by the generator. Dual-ship of a committed `plugin/` core mirror is forbidden. Physical deletion of leftover `plugin/` is #1050 and is not this requirement.

#### Scenario: Generator does not write pipeline.ts under plugin/

- **WHEN** `node scripts/build.mjs` runs
- **THEN** the generator SHALL NOT write `plugin/**/core/scripts/pipeline.ts`
- **AND** SHALL NOT copy `core/scripts` into `plugin/`

#### Scenario: Install does not require a plugin core copy

- **WHEN** `plugin/**/core/scripts/pipeline.ts` is absent
- **AND** `install --host claude` runs (not dry-run)
- **THEN** install SHALL still provision the CLI from `core/` at the repository source
- **AND** SHALL NOT fail solely because the plugin core copy is missing

### Requirement: Build and install SHALL NOT emit a per-verb command pack

`scripts/build.mjs` and `scripts/install.mjs` SHALL NOT generate Claude `pipeline:<verb>.md` files or Codex `pipeline-<verb>.yaml` command agents from `OPERATION_SURFACE`. There SHALL be no marketplace per-verb slash-command pack. `OPERATION_SURFACE` SHALL remain the verb catalog for docs and the SKILL table. It SHALL NOT be a reason to emit one file per verb. OpenCode’s native `/pipeline` command file is out of scope for this requirement. `#990` (splitting `pipeline.ts`) is not required.

#### Scenario: Claude install writes no pipeline colon command files

- **WHEN** `install --host claude` completes successfully (not dry-run)
- **THEN** no `pipeline:*.md` file SHALL exist under the resolved Claude `commands/` directory as a result of that install

#### Scenario: Codex install writes no yaml command agents from OPERATION_SURFACE

- **WHEN** `install --host codex` completes successfully (not dry-run)
- **THEN** the installer SHALL NOT write `pipeline-<name>.yaml` command agents generated from `OPERATION_SURFACE`

#### Scenario: Build writes no plugin slash-command tree

- **WHEN** `node scripts/build.mjs` runs
- **THEN** the generator SHALL NOT write `plugin/pipeline/commands/pipeline:<verb>.md` files

#### Scenario: OPERATION_SURFACE remains a catalog

- **WHEN** a documented CLI verb is listed in `OPERATION_SURFACE`
- **THEN** that listing SHALL be available as catalog input for docs and the SKILL verb table
- **AND** SHALL NOT by itself cause a host command file to be generated

### Requirement: build check SHALL assert SKILL and catalog freshness only

`node scripts/build.mjs --check` SHALL exit non-zero when the generated SKILL overlay or marketplace catalog is stale relative to `hosts/claude/` and the catalog source. It SHALL NOT require a byte-identical `plugin/` core tree. Absence of `plugin/**/core/scripts/**` SHALL NOT by itself fail `--check`.

#### Scenario: Matching SKILL and catalog pass without a core copy

- **WHEN** the generated SKILL overlay and marketplace catalog match the sources
- **AND** `plugin/` has no byte-identical `core/scripts` tree
- **THEN** `node scripts/build.mjs --check` SHALL exit 0

#### Scenario: Stale SKILL or catalog fails check

- **WHEN** the committed SKILL overlay or marketplace catalog differs from a fresh generation
- **THEN** `node scripts/build.mjs --check` SHALL exit non-zero

### Requirement: Operator-visible CLI verbs SHALL stay unchanged

The pipeline CLI SHALL keep the operator-visible keywords `doctor`, `status`, `single`, and the rest of the existing keyword surface, with the same arguments and behavior. Promoting host SKILL text to exec `pipeline <verb>` SHALL NOT rename, drop, or gate those keywords.

#### Scenario: doctor status and single still dispatch

- **WHEN** an operator runs `pipeline doctor`, `pipeline status <N>`, or `pipeline single <N>`
- **THEN** the CLI SHALL dispatch those verbs with the same argument contracts as before this change

### Requirement: This change SHALL NOT delete the plugin directory

This change SHALL NOT `git rm -r plugin/` or otherwise take deletion of the whole `plugin/` tree as its deliverable. That delete is #1050 on the same ship. Regenerating without a core copy MAY drop leftover `plugin/` core files as a side effect. The change MUST NOT restore a core copy.

#### Scenario: plugin directory delete is not this deliverable

- **WHEN** this change’s diff is inspected for a whole-tree `plugin/` delete
- **THEN** it SHALL NOT claim `git rm -r plugin/` as done
- **AND** #1050 SHALL remain the owner of deleting the `plugin/` directory
