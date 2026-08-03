## ADDED Requirements

### Requirement: Docs freshness check surface SHALL include the README landing-page contract when the docs generator is present

When the worktree is docs-generator-present (this repository's `scripts/generate-docs.mjs` / wired `docs:check` contract), the docs freshness check used by the pre-PR path and by `ci:docs` SHALL include enforcement of the root `README.md` landing-page contract defined by `docs-landing-split` (line budget under 400, required companion links, no full hand-maintained CLI/config inventory in the README body). A landing-page contract failure SHALL be treated as a docs-check failure: non-zero exit, no successful implement push/PR create as a gate pass, and no advertisement of implement success solely on green unit tests. Generator-absent consumer worktrees remain inert for this capability as today.

#### Scenario: Over-budget README blocks pre-PR the same class as stale generated docs

- **WHEN** the worktree is docs-generator-present
- **AND** root `README.md` violates the landing-page line budget
- **AND** the post-implementation docs freshness check runs
- **THEN** the implement/test-gate path SHALL block
- **AND** SHALL NOT call `createPr`
- **AND** SHALL NOT push the red-docs head as a successful implement outcome

#### Scenario: Landing-page failure diagnostics are operator-visible

- **WHEN** the docs check fails because of the README landing-page contract
- **THEN** the failure output or stage reason SHALL indicate a README / landing-page contract breach (not only a generic non-zero exit)
- **AND** SHALL NOT invent stale generator file names that were not part of the failure

#### Scenario: Generator-absent repos stay inert

- **WHEN** the worktree is not docs-generator-present
- **THEN** the pipeline SHALL NOT run README landing-page enforcement solely for this capability
- **AND** SHALL remain a no-op for docs-freshness as previously specified

---

### Requirement: Auto-heal SHALL NOT claim to fix a README landing-page contract breach by regenerating generator outputs alone

When docs check fails solely because root `README.md` violates the landing-page contract, the docs auto-heal path (generator write mode + commit of generator outputs) SHALL NOT treat that failure as healed by regenerating `docs/cli.md`, `docs/config.md`, `CHANGELOG.md`, or SKILL regions alone. The path SHALL fail closed with diagnostics naming the README contract breach unless a separate, explicit restore of a compliant README is performed outside silent auto-heal truncation.

#### Scenario: Generator-only heal does not greenwash a monolithic README

- **WHEN** docs check is red because `README.md` exceeds the landing-page line budget
- **AND** auto-heal runs the generator in write mode and commits only generator-owned artifacts
- **AND** `README.md` remains over budget
- **THEN** the re-check SHALL remain non-zero
- **AND** the stage SHALL NOT open or update a PR as a successful docs-healed outcome

#### Scenario: Stale generated artifact heal remains available for generator-owned paths

- **WHEN** docs check is red only because a generator-owned artifact is stale and README is compliant
- **THEN** the existing auto-heal behavior for generator outputs SHALL remain available as previously specified
