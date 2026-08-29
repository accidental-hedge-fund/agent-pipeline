## Purpose

Install the pipeline CLI for Claude the same way as Codex and Grok: a staged launcher, repository `core/`, current-main Node resolver, and a SKILL that execs `pipeline <verb>`, with fail-soft dependency prewarm and fail-closed first-run retry. Do not vendor engine source into `plugin/` and do not emit a `/pipeline:*` command pack.

## ADDED Requirements

### Requirement: Claude install SHALL provision the pipeline CLI

`install --host claude` (not dry-run) SHALL build the pipeline CLI as a complete sibling staging tree before publishing it under the resolved Claude skill install: launcher, whitelisted `core/` tree, and Claude host SKILL overlay. After tree publication, the installer SHALL best-effort prewarm runtime dependencies with `npm ci` at `core/node_modules`. Missing npm or failed prewarm SHALL emit a named warning and SHALL NOT discard the completed install. Every non-dry-run mutating installer command (`install`, `update`, or `uninstall`) SHALL hold a process-owned installer-operation lock from before destination inspection through its tree mutation and any dependency prewarm; a competing command SHALL fail before replacing or removing an install tree or spawning `npm ci`. An abandoned installer-operation lock SHALL NOT be reclaimed automatically, because the prior installer's npm child can outlive its parent. That installer-only lock SHALL remain distinct from the update lock observed by launchers, so a first launcher can wait on the published core-local dependency owner. Before replacement or removal of an existing tree, the installer SHALL also refuse any extant core-local dependency-owner lock, including one whose parent died, until remediation rules out a surviving npm child. A fresh install that will prewarm SHALL publish its incomplete marker and dependency-owner lock with the rest of the tree in the same rename, so a first launcher cannot race installer-owned `npm ci`. A failed prewarm SHALL remove any partial `core/node_modules` or explicitly mark it incomplete so the launcher performs its documented first-run self-heal before a dependency-requiring verb dispatches. Concurrent first-run launchers SHALL serialize self-heal so at most one `npm ci` mutates the installed core while every successful waiter dispatches only after dependencies are ready. An abandoned dependency-owner lock SHALL fail closed without starting another `npm ci`, because a child install can outlive its recorded parent; remediation SHALL require ruling out that child before removing the exact lock or reinstalling. If self-heal otherwise fails, the invocation SHALL also fail closed with remediation. Claude SHALL get the engine the same way as Codex and Grok. The SKILL SHALL instruct the agent to exec `pipeline <verb>`. Short SKILL prose is owned by #1049; this requirement is satisfied by pointing install at the current host SKILL overlay. Dry-run SHALL NOT write the skill tree.

#### Scenario: Claude install publishes a complete launcher core and SKILL tree

- **WHEN** `install --host claude` completes successfully (not dry-run)
- **THEN** the Claude skill install SHALL contain a launcher that dispatches the pipeline CLI
- **AND** SHALL contain the whitelisted `core/` tree
- **AND** SHALL contain the Claude host SKILL overlay
- **AND** SHALL either contain successfully prewarmed `core/node_modules` or remain ready for the launcher's documented first-run self-heal

#### Scenario: Failed dependency prewarm leaves a self-healable install

- **WHEN** staging and tree publication succeed but install-time npm is absent or `npm ci` exits non-zero after creating a partial `core/node_modules`
- **THEN** install SHALL exit successfully with a named warning
- **AND** the installed launcher, core tree, and SKILL SHALL remain in place
- **AND** partial `core/node_modules` SHALL be absent or explicitly marked incomplete
- **AND** the next dependency-requiring launcher invocation with working npm SHALL run the first-run self-heal before dispatch
- **AND** that invocation SHALL fail closed with remediation if self-heal cannot complete

#### Scenario: Installed launcher accepts doctor and status

- **WHEN** `install --host claude` has completed
- **AND** the installed launcher is invoked as `doctor`
- **THEN** the CLI SHALL dispatch the doctor verb (preflight). It SHALL NOT fail because a slash-command file is missing
- **AND** when invoked as `status <N>` it SHALL dispatch the status verb. It SHALL NOT fail because a slash-command file is missing

#### Scenario: Concurrent self-heal is serialized

- **WHEN** two installed launchers start while dependencies are marked incomplete
- **THEN** at most one launcher SHALL run recovery `npm ci` against the shared core at a time
- **AND** both invocations SHALL dispatch after that recovery succeeds
- **AND** no incomplete marker or dependency-install owner lock SHALL remain

#### Scenario: Fresh-install prewarm is owned before publication

- **WHEN** a fresh install publishes the complete skill tree and begins dependency prewarm
- **THEN** the published core SHALL already contain its incomplete marker and live dependency-owner lock
- **AND** a concurrent first launcher SHALL wait for installer prewarm instead of starting a second `npm ci`
- **AND** the launcher SHALL dispatch after installer prewarm succeeds

#### Scenario: Concurrent fresh installers have one publisher and prewarm owner

- **WHEN** a second fresh installer starts while the first installer is prewarming its published core
- **THEN** the second installer SHALL fail before replacing the first installer's tree or starting `npm ci`
- **AND** the first installer SHALL complete with exactly one dependency prewarm attempt
- **AND** it SHALL release both its core-local dependency lock and installer-operation lock

#### Scenario: Uninstall cannot remove a core with possible dependency work

- **WHEN** uninstall starts while another installer is prewarming or an abandoned core-local dependency lock remains
- **THEN** uninstall SHALL fail before removing the installed tree
- **AND** it SHALL preserve the exact ownership lock and name recovery that first rules out a surviving `npm ci` child

#### Scenario: Abandoned dependency ownership fails closed

- **WHEN** dependencies remain incomplete and the recorded dependency-owner process is no longer live
- **THEN** the launcher SHALL NOT start another `npm ci` or dispatch the requested verb
- **AND** it SHALL preserve the incomplete marker and exact owner lock
- **AND** it SHALL name remediation that rules out a surviving npm child before removing that lock or reinstalling

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

`scripts/build.mjs` and `scripts/install.mjs` SHALL NOT generate Claude `pipeline:<verb>.md` files or Codex `pipeline-<verb>.yaml` command agents from `OPERATION_SURFACE`. There SHALL be no marketplace per-verb slash-command pack. `OPERATION_SURFACE` SHALL remain the verb catalog for docs and the SKILL table. It SHALL NOT be a reason to emit one file per verb. OpenCode’s LLM-mediated `/pipeline` markdown command file is out of scope for this requirement. `#990` (splitting `pipeline.ts`) is not required.

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
