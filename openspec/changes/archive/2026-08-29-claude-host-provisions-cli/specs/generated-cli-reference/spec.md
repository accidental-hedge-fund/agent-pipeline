## MODIFIED Requirements

### Requirement: Committed CLI reference artifacts SHALL be staleness-gated in CI

The repository SHALL provide a check mode for the CLI reference generator via `scripts/generate-docs.mjs --check` (or an equivalent `docs:check` script that invokes that check mode) that exits non-zero when the committed `docs/cli.md` or either host SKILL generated command-table region differs from a fresh generation. That check SHALL be reached from the root `npm run ci` gate through the existing conditional docs-freshness step (`ci:docs`) once the generator is present, so a stale committed reference fails CI the same way a stale generated SKILL/catalog output fails `build.mjs --check`.

#### Scenario: Stale docs/cli.md fails the check

- **WHEN** `docs/cli.md` is edited by hand (or left unchanged after a registry/doc-metadata change) so it no longer matches a fresh generation
- **THEN** the docs generator check mode SHALL exit non-zero

#### Scenario: Fresh generation passes the check

- **WHEN** all generated CLI reference artifacts match a fresh generation run
- **THEN** the docs generator check mode SHALL exit zero for those artifacts

#### Scenario: CI invokes the staleness check when generator is present

- **WHEN** a contributor runs `npm run ci` from the repo root on a tree that contains `scripts/generate-docs.mjs`
- **THEN** the CLI reference staleness check SHALL run as part of that gate (via `ci:docs` / `docs:check` / `generate-docs.mjs --check`)
