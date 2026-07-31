## ADDED Requirements

### Requirement: Full CI chain always includes a conditional docs freshness step

The root `package.json` `ci` script SHALL always reach a docs-freshness entry point (directly or via a named script such as `ci:docs`) that is **conditional on generator presence**:

1. When the worktree is **not** docs-generator-present (no `scripts/generate-docs.mjs` and no `docs:check` script that invokes that generator contract), the entry point SHALL exit 0 without failing the gate and without requiring a missing generator.
2. When the worktree **is** docs-generator-present, the entry point SHALL run a **check-mode** docs freshness invocation (`npm run docs:check` only when that script is itself check-mode for the generator, or `node scripts/generate-docs.mjs --check`) and SHALL exit non-zero when generated artifacts are stale.

This keeps the `ci` script graph and project documentation aligned whether or not the generator is currently on the branch, matching the conditional pattern used for OpenSpec validation. A structural drift-guard SHALL fail if the conditional docs entry is removed from the `ci` chain.

#### Scenario: Generator absent — ci docs step is a no-op

- **WHEN** the repository has no docs generator entry point and no generator-wired `docs:check`
- **AND** `npm run ci` runs (including the docs freshness entry point)
- **THEN** the docs entry point SHALL exit 0
- **AND** SHALL NOT fail `npm run ci` solely because a docs generator is absent
- **AND** SHALL NOT invoke a non-existent generator as a hard error

#### Scenario: Generator present — ci docs step is real check-mode

- **WHEN** `scripts/generate-docs.mjs` is present (or `package.json` defines a check-mode `docs:check` that invokes it)
- **AND** the `ci` npm script graph is inspected structurally
- **THEN** `ci` SHALL reach a check-mode docs freshness step
- **AND** a stale committed generated artifact SHALL make that step exit non-zero and fail `npm run ci`

#### Scenario: Drift-guard fails if conditional docs entry is dropped from ci

- **WHEN** a test inspects the root `package.json` `ci` script chain
- **AND** the conditional docs freshness entry point is absent from that chain
- **THEN** the test SHALL fail
- **AND** the test SHALL fail if that assertion is removed while this requirement remains in force

#### Scenario: Write-mode-only docs:check does not count as check-mode under the conditional step

- **WHEN** `docs:check` is defined as generator write-mode without `--check` on the generator invocation
- **AND** the worktree is otherwise docs-generator-present via `scripts/generate-docs.mjs`
- **THEN** the conditional docs entry point SHALL still invoke a real check-mode command (e.g. `node scripts/generate-docs.mjs --check`) rather than treating write-mode `docs:check` as sufficient freshness checking

### Requirement: Build guidance describes conditional docs freshness and CI checkout parity

Repository build/test guidance that documents `npm run ci` (README and CLAUDE.md / AGENTS.md as applicable) SHALL state that:

1. The full CI gate includes a **conditional** docs freshness step (no-op when the generator is absent; real check when present); and
2. The GitHub Actions PR/main CI workflow checks out full history and tags so tag-dependent generators match local full clones.

Guidance SHALL NOT claim an unconditional `docs:check` that is missing from `package.json`, and SHALL NOT imply that default shallow Actions checkout is sufficient for tag-sourced generators.

#### Scenario: CLAUDE.md / AGENTS.md match the conditional ci docs step

- **WHEN** a contributor reads the build/test (`npm run ci`) guidance in CLAUDE.md or AGENTS.md
- **THEN** they SHALL find that docs freshness is part of `npm run ci` in a **conditional** form (when the generator is present / no-op when absent)
- **AND** SHALL NOT be told that `ci` always runs a hard `docs:check` on generator-absent trees

#### Scenario: README notes Actions full-history checkout for generator parity

- **WHEN** a contributor reads README guidance about `npm run ci` / CI
- **THEN** they SHALL find that Actions PR/main CI uses full history and tags (or equivalent language) for generator/local parity when tag-dependent generators exist
- **AND** SHALL NOT be led to believe that a green local full clone can differ from Actions solely due to intentional shallow checkout for this gate
