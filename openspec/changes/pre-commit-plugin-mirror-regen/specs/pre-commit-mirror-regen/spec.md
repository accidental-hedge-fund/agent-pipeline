## ADDED Requirements

### Requirement: A committed pre-commit hook SHALL auto-regenerate and stage the plugin/ mirror when core/ or hosts/claude/ paths are staged

The repository SHALL include a `.githooks/pre-commit` shell script. When a contributor runs `git commit` and the staged file set includes at least one path under `core/` or `hosts/claude/`, the hook SHALL run `node scripts/build.mjs`, then stage `plugin/` and `.claude-plugin/marketplace.json` before the commit object is created.

#### Scenario: Core edit auto-regenerates mirror

- **WHEN** a contributor stages changes under `core/` and runs `git commit`
- **THEN** the pre-commit hook SHALL run `node scripts/build.mjs`
- **AND** the hook SHALL run `git add plugin/ .claude-plugin/marketplace.json`
- **AND** the resulting commit SHALL include both the `core/` edits and the regenerated `plugin/` tree

#### Scenario: hosts/claude edit triggers regeneration

- **WHEN** a contributor stages changes under `hosts/claude/` and runs `git commit`
- **THEN** the pre-commit hook SHALL detect the staged path and trigger regeneration as in the core-edit scenario

#### Scenario: Unrelated commit skips regeneration

- **WHEN** a contributor stages only paths outside `core/` and `hosts/claude/` (e.g., `README.md`, `openspec/`)
- **THEN** the pre-commit hook SHALL exit 0 without running `build.mjs` or staging any additional files

#### Scenario: Hook failure aborts commit

- **WHEN** `node scripts/build.mjs` exits with a non-zero status during the hook
- **THEN** the pre-commit hook SHALL exit non-zero
- **AND** the `git commit` SHALL be aborted so the contributor can fix the build error before committing

#### Scenario: Hook stages only generated paths

- **WHEN** the contributor has unrelated unstaged changes in the working tree at commit time
- **THEN** the hook SHALL stage only `plugin/` and `.claude-plugin/marketplace.json`
- **AND** SHALL NOT stage any other working-tree changes

### Requirement: The repository SHALL provide a one-command hook setup script

A `setup-hooks` entry in `package.json` scripts SHALL invoke `scripts/setup-hooks.mjs`, which SHALL set `git config --local core.hooksPath .githooks` and print a confirmation message. Contributors SHALL be able to wire the hook by running `npm run setup-hooks`.

#### Scenario: setup-hooks wires core.hooksPath

- **WHEN** a contributor runs `npm run setup-hooks`
- **THEN** `git config --local core.hooksPath` SHALL be set to `.githooks`
- **AND** the script SHALL print a confirmation indicating the hook is active

#### Scenario: Contributor docs reference setup

- **WHEN** a contributor reads the `README.md`
- **THEN** it SHALL contain a note directing contributors to run `npm run setup-hooks` to activate the pre-commit hook
