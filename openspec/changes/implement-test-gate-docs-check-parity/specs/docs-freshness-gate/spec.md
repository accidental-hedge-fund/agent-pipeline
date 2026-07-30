## ADDED Requirements

### Requirement: Docs freshness enforcement activates only when a docs generator is present

The pipeline SHALL treat a worktree as **docs-generator-present** when it contains the repository docs generator entry point `scripts/generate-docs.mjs` and/or a `package.json` script `docs:check` that invokes that generator (or an equivalent `node scripts/generate-docs.mjs --check` invocation). When the worktree is **not** docs-generator-present, all docs-freshness-gate behaviors SHALL be inert: no generate/check invocations, no docs-only auto-heal commits, and no additional pre-PR blocks attributable to this capability.

#### Scenario: Generator absent is a no-op

- **WHEN** the worktree has no `scripts/generate-docs.mjs` and no `docs:check` script wired to it
- **THEN** the pipeline SHALL NOT run a docs generate or docs check solely for this capability
- **AND** SHALL NOT block implement/test-gate for missing docs freshness

#### Scenario: Generator present activates enforcement

- **WHEN** the worktree is docs-generator-present
- **THEN** the pre-PR path SHALL enforce docs freshness as specified in the remaining requirements of this capability

### Requirement: Implement and test-gate SHALL run the same docs freshness check CI runs before PR open or update

When the worktree is docs-generator-present, the post-implementation path (first open and resume) SHALL run the repo's docs freshness check — `npm run docs:check`, `node scripts/generate-docs.mjs --check`, or the docs-freshness step of `npm run ci` — **before** advertising implement success and **before** creating or updating a PR (before `createPr` and before treating an existing-PR resume as gate-passed for advance). A non-zero docs check SHALL prevent PR create/update advance on that path.

#### Scenario: Stale generated docs blocks before PR create

- **WHEN** the worktree is docs-generator-present
- **AND** the docs freshness check exits non-zero because a generated artifact is stale (e.g. `CHANGELOG.md`)
- **AND** auto-heal has not yet made the check green (or is not applicable)
- **THEN** the implement/test-gate path SHALL block
- **AND** SHALL NOT call `createPr`
- **AND** SHALL NOT advertise implement success for that attempt

#### Scenario: Resume with existing PR also fails closed

- **WHEN** a PR already exists for the branch
- **AND** the docs freshness check is red for the current worktree HEAD
- **THEN** the resume post-implementation path SHALL block rather than push a red-docs head as a successful gate pass
- **AND** SHALL NOT treat the item as advanced past implement verification

#### Scenario: Green docs check allows the existing PR path to continue

- **WHEN** the worktree is docs-generator-present
- **AND** the docs freshness check exits 0
- **THEN** the post-implementation path SHALL proceed to push/PR steps subject to other existing gates (format/test, clean tree, etc.)

### Requirement: On docs-check failure the stage SHALL auto-heal or fail closed naming stale files

When docs-generator-present and the docs freshness check fails, the implement/test-gate path SHALL either:

1. **Auto-heal:** run the generator in write mode (`npm run docs:generate` or `node scripts/generate-docs.mjs`), commit any resulting generated-output changes with a conventional docs-regenerate commit message that references the issue number, re-run the freshness check until green within the stage's bounded budget, **or**
2. **Fail closed:** block with a reason that names the stale file(s) reported by the check (e.g. `CHANGELOG.md`) and does not open/update a PR.

The path SHALL NOT open or update a PR while the docs freshness check is red. Prefer auto-heal when the generator write mode is available and the worktree is clean enough to attribute dirt to generation (same clean-tree precondition class as build-artifact fold).

#### Scenario: Auto-heal regenerates and commits then passes

- **WHEN** docs check fails because a generated file is stale
- **AND** running the generator in write mode updates that file
- **THEN** the stage SHALL commit the regenerated outputs
- **AND** re-run the docs freshness check
- **AND** when the re-check exits 0, SHALL allow the post-implementation path to continue (subject to other gates)

#### Scenario: Fail closed names stale files

- **WHEN** docs check remains non-zero after auto-heal is exhausted or cannot run
- **THEN** the stage SHALL block with a reason that includes the stale file name(s) from the check output
- **AND** SHALL NOT call `createPr`

#### Scenario: Never open a PR with a failing docs check

- **WHEN** the docs freshness check is non-zero for the HEAD that would be pushed
- **THEN** the pipeline SHALL NOT create a new PR for that HEAD as a successful implement outcome
- **AND** SHALL NOT classify the item as ready for review solely on the basis of green unit tests while docs check is red

### Requirement: Implementing prompt requires regenerating generator outputs for docs-generator work

When documentation steps are enabled and the repository is docs-generator-present (or the issue/plan is docs-primary / touches the docs generator, its templates, or its generated outputs), the implementing prompt or verification contract SHALL explicitly require that the implementer regenerate and commit **all** generator outputs in the same change as the generator code or source edits that affect those outputs. The prompt SHALL NOT allow "tests only" success language that omits generator outputs for such work.

#### Scenario: Docs-primary issue prompt mentions regenerate and commit

- **WHEN** the implementing prompt is built for a change that introduces or modifies the docs generator or its outputs (or `steps.docs` is on with docs-generator-present)
- **THEN** the rendered prompt SHALL instruct the implementer to regenerate and commit generator outputs in the same change
- **AND** SHALL name the check command operators/CI use (e.g. `npm run docs:check` or `node scripts/generate-docs.mjs --check`) when that surface exists

#### Scenario: No generator — existing docs instruction unchanged in spirit

- **WHEN** the worktree is not docs-generator-present
- **THEN** the pipeline SHALL NOT require docs-generator regenerate commands that do not exist
- **AND** the existing optional documentation-updates instruction MAY still apply for hand-maintained docs

### Requirement: A regression test proves stale generated docs fail before PR creation

The repository test suite SHALL include a regression that constructs a deliberate stale generated-docs condition (e.g. stale `CHANGELOG.md` or an injected non-zero docs-check result) and asserts that the implement/test-gate pre-PR path blocks and does **not** invoke PR creation. The test SHALL use injectable dependency seams (no real network, git, or subprocess as the sole pass path) and SHALL fail if the pre-PR docs-failure path is removed.

#### Scenario: Deliberate stale CHANGELOG fails before createPr

- **WHEN** a unit/fixture test injects a failing docs freshness check (or a stale generated docs artifact seam) on the post-implementation path
- **THEN** the test SHALL assert the outcome is a block/failure
- **AND** SHALL assert `createPr` was not called
- **AND** the test SHALL fail if that assertion path is deleted or always-skipped

#### Scenario: Test bites without the fix

- **WHEN** the pre-PR docs-check enforcement is removed or bypassed
- **THEN** the regression test SHALL fail (proving it would have caught the #597-class escape)
