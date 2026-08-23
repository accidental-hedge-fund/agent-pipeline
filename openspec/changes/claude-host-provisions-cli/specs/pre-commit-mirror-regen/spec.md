## MODIFIED Requirements

### Requirement: A committed pre-commit hook SHALL auto-regenerate and stage the plugin/ mirror when core/, hosts/claude/, or hosts/_shared/ paths are staged

The repository SHALL include a `.githooks/pre-commit` shell script. When a contributor runs `git commit` and the staged file set includes at least one path under `core/`, `hosts/claude/`, or `hosts/_shared/`, the hook SHALL run `node scripts/build.mjs`. Until #1050 deletes `plugin/`, the hook MAY stage generated SKILL overlay and marketplace catalog outputs (`plugin/` SKILL/catalog paths and `.claude-plugin/marketplace.json`) before the commit object is created. The hook SHALL NOT regenerate or stage a `plugin/` copy of `core/scripts` as required output. `hosts/claude/` still provides the SKILL.md overlay. `hosts/_shared/` still provides `entry.template.mjs` used to generate the installed launcher shim.

#### Scenario: Core edit auto-regenerates mirror

- **WHEN** a contributor stages changes under `core/` and runs `git commit`
- **THEN** the pre-commit hook SHALL run `node scripts/build.mjs`
- **AND** the hook SHALL NOT stage a `plugin/` core copy as required output
- **AND** the hook MAY stage generated SKILL overlay and marketplace catalog files when the generator still writes them

#### Scenario: hosts/claude edit triggers regeneration

- **WHEN** a contributor stages changes under `hosts/claude/` and runs `git commit`
- **THEN** the pre-commit hook SHALL detect the staged path and trigger regeneration as in the core-edit scenario

#### Scenario: hosts/_shared edit triggers regeneration

- **WHEN** a contributor stages changes under `hosts/_shared/` and runs `git commit`
- **THEN** the pre-commit hook SHALL detect the staged path and trigger regeneration as in the core-edit scenario

#### Scenario: Unrelated commit skips regeneration

- **WHEN** a contributor stages only paths outside `core/`, `hosts/claude/`, and `hosts/_shared/` (e.g., `README.md`, `openspec/`)
- **THEN** the pre-commit hook SHALL exit 0 without running `build.mjs` or staging any additional files

#### Scenario: Hook failure aborts commit

- **WHEN** `node scripts/build.mjs` exits with a non-zero status during the hook
- **THEN** the pre-commit hook SHALL exit non-zero
- **AND** the `git commit` SHALL be aborted so the contributor can fix the build error before committing

#### Scenario: Hook stages only generated paths

- **WHEN** the contributor has unrelated unstaged changes in the working tree at commit time
- **THEN** the hook SHALL stage only generator-owned SKILL/catalog outputs when it stages anything
- **AND** SHALL NOT stage any other working-tree changes
- **AND** SHALL NOT stage a `plugin/` core copy as required output

#### Scenario: Untracked source files abort the hook

- **WHEN** a contributor stages a `core/`, `hosts/claude/`, or `hosts/_shared/` change and untracked files exist under any of those directories
- **THEN** the pre-commit hook SHALL exit non-zero and abort the commit
- **AND** the hook SHALL list the untracked files so the contributor can track, stash, or remove them before committing
