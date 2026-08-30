# pre-commit-mirror-regen Specification

## Purpose
TBD - created by archiving change pre-commit-plugin-mirror-regen. Update Purpose after archive.
## Requirements
### Requirement: The repository SHALL provide a one-command hook setup script

A `setup-hooks` entry in `package.json` scripts SHALL invoke `scripts/setup-hooks.mjs`, which SHALL set `git config --local core.hooksPath .githooks` and print a confirmation message. Contributors SHALL be able to wire the hook by running `npm run setup-hooks`.

#### Scenario: setup-hooks wires core.hooksPath

- **WHEN** a contributor runs `npm run setup-hooks`
- **THEN** `git config --local core.hooksPath` SHALL be set to `.githooks`
- **AND** the script SHALL print a confirmation indicating the hook is active

#### Scenario: Contributor docs reference setup

- **WHEN** a contributor reads the `README.md`
- **THEN** it SHALL contain a note directing contributors to run `npm run setup-hooks` to activate the pre-commit hook

### Requirement: A committed pre-commit hook SHALL refresh exact generated SKILL/catalog outputs when generator inputs or generated host SKILLs are staged

The repository SHALL include a `.githooks/pre-commit` shell script. The hook
SHALL run `node scripts/build.mjs` when the staged set touches a SKILL/catalog
generator input under `core/` or `hosts/_shared/`, `scripts/build.mjs`, any
exact generated host SKILL path (`hosts/claude/SKILL.md`,
`hosts/codex/SKILL.md`, `hosts/grok/SKILL.md`, or
`hosts/opencode/SKILL.md`), or any exact repository manifest input
(`hosts/claude/outer-host.manifest.json`,
`hosts/codex/outer-host.manifest.json`,
`hosts/grok/outer-host.manifest.json`, or
`hosts/opencode/outer-host.manifest.json`). Its unstaged and untracked
generator-input guards SHALL cover those exact manifest inputs as well as the
existing generator-input directories. It SHALL stage only the exact generator-owned host
SKILLs, transitional plugin SKILL, and marketplace catalog that the build
owns; it SHALL NOT use a broad `git add hosts/` or `git add plugin/`. The hook
SHALL NOT regenerate or stage a `plugin/` copy of `core/scripts`.
`renderHostSkill` plus its catalog and manifest inputs provide the SKILL bytes;
`hosts/claude/SKILL.md` SHALL NOT be treated as the source for the plugin
overlay. Shared plugin-shell assets under `hosts/_shared/` remain generator
inputs.

#### Scenario: Core edit refreshes generated packaging outputs

- **WHEN** a contributor stages changes under `core/` and runs `git commit`
- **THEN** the pre-commit hook SHALL run `node scripts/build.mjs`
- **AND** the hook SHALL NOT stage a `plugin/` core copy as required output
- **AND** the hook MAY stage only changed exact generated host SKILL, plugin
  SKILL, and marketplace catalog paths

#### Scenario: hosts/claude edit triggers regeneration

- **WHEN** a contributor stages `hosts/claude/SKILL.md` and runs `git commit`
- **THEN** the pre-commit hook SHALL detect that generated path and trigger
  regeneration as in the core-edit scenario
- **AND** it SHALL normalize all four host SKILLs from the shared renderer

#### Scenario: hosts/_shared edit triggers regeneration

- **WHEN** a contributor stages changes under `hosts/_shared/` and runs
  `git commit`
- **THEN** the pre-commit hook SHALL detect the staged input and trigger
  regeneration as in the core-edit scenario

#### Scenario: Outer-host manifest edit triggers regeneration

- **WHEN** a contributor stages any one of the four selected hosts'
  `outer-host.manifest.json` files and runs `git commit`
- **THEN** the pre-commit hook SHALL run `node scripts/build.mjs`
- **AND** it SHALL stage changed generated outputs only by their exact owned paths

#### Scenario: Unstaged selected-host manifest aborts regeneration

- **WHEN** another declared generator input triggers the hook while one of the
  four selected outer-host manifests has an unstaged tracked edit
- **THEN** the hook SHALL abort before generation can incorporate that unstaged mapping
- **AND** it SHALL name the unstaged manifest for remediation

#### Scenario: Unrelated commit skips regeneration

- **WHEN** a contributor stages only paths outside the declared generator
  inputs, exact selected outer-host manifests, and exact generated host SKILL
  paths (for example `README.md` or an
  unrelated `openspec/` file)
- **THEN** the pre-commit hook SHALL exit 0 without running `build.mjs` or
  staging any additional files

#### Scenario: Hook failure aborts commit

- **WHEN** `node scripts/build.mjs` exits with a non-zero status during the hook
- **THEN** the pre-commit hook SHALL exit non-zero
- **AND** the `git commit` SHALL be aborted so the contributor can fix the
  build error before committing

#### Scenario: Hook stages only generated paths

- **WHEN** the contributor has unrelated unstaged changes in the working tree
  at commit time
- **THEN** the hook SHALL stage only the exact four host SKILL paths,
  `plugin/pipeline/skills/pipeline/SKILL.md`, and
  `.claude-plugin/marketplace.json` when those generated outputs changed
- **AND** SHALL NOT stage any other working-tree changes or a broad host/plugin
  directory
- **AND** SHALL NOT stage a `plugin/` core copy as required output

#### Scenario: Untracked source files abort the hook

- **WHEN** a contributor stages a declared generator input or generated host
  SKILL and untracked files exist under a generator-input directory or at a
  declared selected-host manifest input
- **THEN** the pre-commit hook SHALL exit non-zero and abort the commit
- **AND** the hook SHALL list the untracked input files so the contributor can
  track, stash, or remove them before committing

