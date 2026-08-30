## RENAMED Requirements

- FROM: ### Requirement: Release help and host SKILL SHALL document the required release-plan row shape
- TO: ### Requirement: Release help and durable operator docs SHALL document the required release-plan row shape

## MODIFIED Requirements

### Requirement: Release help and durable operator docs SHALL document the required release-plan row shape

Release usage/help output and durable operator documentation SHALL describe the
release-plan table row shape in a form consistent with the row produced by
plan-row insert and consumed by `patchReleasePlanRow` (columns: Release, Bump,
Theme, Issues, Why; Release cell `| **vX.Y.Z** |` for unshipped). The generated
short host one-pager MAY list the `release` verb and link to that documentation;
it SHALL NOT be required to carry the release-plan row tutorial. The documented
shape SHALL NOT contradict the shape enforced by those helpers.

#### Scenario: Help text states the unshipped plan-row shape

- **WHEN** an operator reads release help or the linked durable release docs
- **THEN** the surface SHALL show or describe the unshipped
  `| **vX.Y.Z** | bump | theme | issues | why |` row shape
- **AND** SHALL note that release will scaffold a missing unshipped row when the
  insert sentinel is present, or fail with remediation when it is not

#### Scenario: Generated one-pager stays compact

- **WHEN** an operator reads a generated host one-pager
- **THEN** its verb table MAY point to the release help or durable CLI reference
- **AND** it SHALL NOT be required to reproduce the release-plan row tutorial

---

### Requirement: Aborts before branch creation SHALL leave the working tree unchanged

The live release SHALL refuse to start if any release-managed path has tracked
or untracked changes. The managed set SHALL include `package.json`,
`core/package.json`, `ROADMAP.md`, `plugin/`, `.claude-plugin/`, and the exact
generated host paths `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`,
`hosts/grok/SKILL.md`, and `hosts/opencode/SKILL.md`. This precondition SHALL
run before version mutation or `node scripts/build.mjs`, because that generator
owns all four host SKILLs as well as plugin/catalog outputs.

Untracked-file detection SHALL remain independent of user git configuration.
The packaging generator SHALL write only its declared exact SKILL, launcher,
material-filter, Node-resolver, manifest, and catalog outputs. It MAY remove
only the two wholly owned retired directories
`plugin/pipeline/commands/` and `plugin/pipeline/skills/pipeline/core/`; it
SHALL NOT treat unrelated files under `hosts/` or `plugin/` as generated.

Any abort after version bump and generation but before release-branch creation
SHALL restore every release-managed path, including the four generated host
SKILLs, to its pre-release `HEAD` state and remove only untracked debris at
declared generator-owned paths. Because the clean precondition covered every
path the generator can mutate, rollback SHALL remain lossless and SHALL NOT
discard a maintainer's pre-existing edit.

#### Scenario: A dirty release-managed path fails fast before any mutation

- **WHEN** any package, ROADMAP, plugin/catalog, or exact generated host SKILL
  path in the release-managed set has tracked or untracked changes at live
  release start
- **THEN** the command SHALL exit non-zero naming the dirty exact paths and
  SHALL NOT bump the version, regenerate packaging outputs, or write any file
- **AND** because nothing was mutated, no rollback is performed

#### Scenario: Untracked-file detection does not depend on user git config

- **WHEN** the clean-tree precondition checks every release-managed path
- **THEN** it SHALL force untracked-file reporting (for example
  `git status --porcelain --untracked-files=all`) so untracked plugin/catalog or
  exact generated host SKILL debris is detected even when
  `status.showUntrackedFiles=no`

#### Scenario: post-bump abort rolls back the bumped files

- **WHEN** the command bumps the version, regenerates packaging outputs, then
  aborts before creating the release branch
- **THEN** `package.json`, `core/package.json`, `ROADMAP.md`, `plugin/`,
  `.claude-plugin/`, and all four exact generated host SKILLs SHALL be restored
  to their pre-release `HEAD` state
- **AND** untracked build debris SHALL be removed only from declared
  generator-owned paths
- **AND** because the clean-tree precondition held for every managed path, no
  pre-existing local edit is discarded by rollback
