## ADDED Requirements

### Requirement: Docs freshness enforcement activates only when a docs generator is present

The pipeline SHALL treat a worktree as **docs-generator-present** when it contains the repository docs generator entry point `scripts/generate-docs.mjs` and/or a `package.json` script `docs:check` that invokes that generator (or an equivalent `node scripts/generate-docs.mjs --check` invocation). An arbitrary `docs:check` script that does not invoke this generator contract SHALL NOT activate the gate. When the worktree is **not** docs-generator-present, all docs-freshness-gate behaviors SHALL be inert: no generate/check invocations, no docs-only auto-heal commits, and no additional pre-PR blocks attributable to this capability. Enforcement SHALL live on the pipeline's generic post-implementation worktree path so consumer repos with a detected generator receive the same pre-PR protection; generator-absent consumer repos SHALL remain inert.

#### Scenario: Generator absent is a no-op

- **WHEN** the worktree has no `scripts/generate-docs.mjs` and no `docs:check` script wired to the generator
- **THEN** the pipeline SHALL NOT run a docs generate or docs check solely for this capability
- **AND** SHALL NOT block implement/test-gate for missing docs freshness

#### Scenario: Unrelated docs:check script does not activate

- **WHEN** `package.json` defines a `docs:check` script that does not invoke `generate-docs.mjs` / the generator contract
- **AND** `scripts/generate-docs.mjs` is absent
- **THEN** the pipeline SHALL treat the worktree as not docs-generator-present for this capability

#### Scenario: Generator present activates enforcement

- **WHEN** the worktree is docs-generator-present
- **THEN** the pre-PR path SHALL enforce docs freshness as specified in the remaining requirements of this capability

### Requirement: Pre-PR docs freshness has one explicit owner and ordering

When the worktree is docs-generator-present, the shared post-implementation path (first open and resume; and the fix path that may push an updated head) SHALL enforce docs freshness **after** implement/fix commits are finalized and format/test gates have converged, and **before** advertising implement success and **before** `git push` / `createPr` / treating an existing-PR resume as gate-passed. The ordered docs step SHALL be: run docs check → optional auto-heal (at most one bounded attempt) → re-run docs check → when a heal commit landed, re-run the normal format+test gates on the new HEAD → only then push and create-or-reuse PR. A non-zero docs check on the HEAD that would be pushed SHALL prevent both new-PR creation and successful push/update advance.

#### Scenario: Stale generated docs blocks before PR create and push

- **WHEN** the worktree is docs-generator-present
- **AND** the docs freshness check exits non-zero because a generated artifact is stale (e.g. `CHANGELOG.md`)
- **AND** auto-heal has not yet made the check green (or is not applicable)
- **THEN** the implement/test-gate path SHALL block
- **AND** SHALL NOT call `createPr`
- **AND** SHALL NOT push the red-docs head as a successful implement outcome
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

#### Scenario: Heal commit re-runs test gates before push

- **WHEN** auto-heal commits regenerated docs outputs
- **AND** the re-check exits 0
- **THEN** the path SHALL re-run format+test gates on the new HEAD before push or PR create/reuse

### Requirement: On docs-check failure the stage SHALL auto-heal or fail closed with real diagnostics

When docs-generator-present and the docs freshness check fails, the implement/test-gate path SHALL either:

1. **Auto-heal (at most one attempt):** require a clean worktree immediately before generate; run the generator in write mode (`npm run docs:generate` or `node scripts/generate-docs.mjs`); commit only dirt attributable to that generate (same clean-tree precondition class as build-artifact fold) with a conventional docs-regenerate commit message that references the issue number; re-run the freshness check; if green and a commit landed, re-run format+test gates on the new HEAD; **or**
2. **Fail closed:** block with a reason that preserves check/generate stdout/stderr and, when the output lists stale paths, names those stale file(s) (e.g. `CHANGELOG.md`); when the failure is not a parseable stale-output report, report the command failure clearly without inventing file names.

The path SHALL NOT open or update a PR while the docs freshness check is red. The path SHALL NOT auto-commit when the worktree was dirty before generate, when generate produces no change, or when generate itself fails.

#### Scenario: Auto-heal regenerates and commits then passes

- **WHEN** docs check fails because a generated file is stale
- **AND** the worktree is clean before generate
- **AND** running the generator in write mode updates that file
- **THEN** the stage SHALL commit the regenerated outputs
- **AND** re-run the docs freshness check
- **AND** when the re-check exits 0, SHALL re-run format+test gates on the new HEAD and then allow the post-implementation path to continue (subject to those gates)

#### Scenario: Dirty worktree prevents auto-commit of unrelated dirt

- **WHEN** docs check is non-zero
- **AND** the worktree has uncommitted changes before generate would run
- **THEN** the stage SHALL NOT commit those unrelated changes as a docs regenerate
- **AND** SHALL fail closed rather than open/update a PR with red docs

#### Scenario: Fail closed names stale files when present

- **WHEN** docs check remains non-zero after auto-heal is exhausted or cannot run
- **AND** the check output lists stale file name(s)
- **THEN** the stage SHALL block with a reason that includes those stale file name(s)
- **AND** SHALL NOT call `createPr`
- **AND** SHALL NOT successfully push that head for advance

#### Scenario: Non-stale generator/check failure does not invent file names

- **WHEN** docs check or generate fails with output that does not list stale paths
- **THEN** the block reason SHALL include the command failure output
- **AND** SHALL NOT claim specific stale file names that were not reported

#### Scenario: Never open or update a PR with a failing docs check

- **WHEN** the docs freshness check is non-zero for the HEAD that would be pushed
- **THEN** the pipeline SHALL NOT create a new PR for that HEAD as a successful implement outcome
- **AND** SHALL NOT push/update an existing PR branch as a successful gate pass while docs check is red
- **AND** SHALL NOT classify the item as ready for review solely on the basis of green unit tests while docs check is red

### Requirement: Implementing prompt requires regenerating generator outputs for docs-generator work

When documentation steps are enabled (`steps.docs` / implementing `docsEnabled`) and the repository worktree is docs-generator-present, the implementing prompt or verification contract SHALL explicitly require that the implementer regenerate and commit **all** generator outputs in the same change as the generator code or source edits that affect those outputs. Prompt applicability SHALL be determined **before** implementation from repository generator detection plus docs-step context — not solely from a post-implementation path diff that does not yet exist. The prompt SHALL NOT allow "tests only" success language that omits generator outputs for such work, and SHALL name the check command operators/CI use when that surface exists.

#### Scenario: Docs-enabled generator-present prompt mentions regenerate and commit

- **WHEN** the implementing prompt is built with `steps.docs` on and the worktree is docs-generator-present
- **THEN** the rendered prompt SHALL instruct the implementer to regenerate and commit generator outputs in the same change
- **AND** SHALL name the check command operators/CI use (e.g. `npm run docs:check` or `node scripts/generate-docs.mjs --check`) when that surface exists

#### Scenario: No generator — existing docs instruction unchanged in spirit

- **WHEN** the worktree is not docs-generator-present
- **THEN** the pipeline SHALL NOT require docs-generator regenerate commands that do not exist
- **AND** the existing optional documentation-updates instruction MAY still apply for hand-maintained docs

### Requirement: A regression test proves stale generated docs fail before PR creation and push

The repository test suite SHALL include regressions that construct a deliberate stale generated-docs condition (e.g. stale `CHANGELOG.md` or an injected non-zero docs-check result) and assert that the implement/test-gate pre-PR path blocks and does **not** invoke PR creation or successful push advance. Tests SHALL use injectable dependency seams (no real network, git, or subprocess as the sole pass path) and SHALL fail if the pre-PR docs-failure path is removed. Tests SHALL also cover auto-heal success and the negative auto-heal cases (no change, generate fail, re-check red, dirty tree), generator-absent no-op, and call-order proofs that docs check occurs before push/`createPr`.

#### Scenario: Deliberate stale CHANGELOG fails before createPr

- **WHEN** a unit/fixture test injects a failing docs freshness check (or a stale generated docs artifact seam) on the post-implementation path
- **THEN** the test SHALL assert the outcome is a block/failure
- **AND** SHALL assert `createPr` was not called
- **AND** the test SHALL fail if that assertion path is deleted or always-skipped

#### Scenario: Red docs blocks push on existing-PR resume

- **WHEN** a unit/fixture test injects a failing docs check on the resume path with an existing PR
- **THEN** the test SHALL assert push is not treated as a successful gate pass
- **AND** SHALL assert the item does not advance past implement verification

#### Scenario: Test bites without the fix

- **WHEN** the pre-PR docs-check enforcement is removed or bypassed
- **THEN** the regression test SHALL fail (proving it would have caught the #597-class escape)
