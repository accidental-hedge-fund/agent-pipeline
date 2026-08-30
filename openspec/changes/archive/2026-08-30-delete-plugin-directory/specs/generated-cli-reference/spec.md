## MODIFIED Requirements

### Requirement: Committed CLI reference artifacts SHALL be staleness-gated in CI

The repository SHALL provide a check mode for the CLI reference generator via `scripts/generate-docs.mjs --check` (or an equivalent `docs:check` script that invokes that check mode) that exits non-zero when the committed `docs/cli.md` differs from a fresh generation. Generated host SKILL freshness SHALL be gated only by `build.mjs --check` for the four SKILL hosts (Claude, Codex, Grok, OpenCode). The root `npm run ci` gate SHALL reach both checks: `build.mjs --check` for host SKILL outputs and the existing conditional `ci:docs` step for docs outputs. A stale CLI reference or host SKILL SHALL therefore fail its sole owning check without two generators claiming the same file. `build.mjs --check` SHALL NOT require a plugin SKILL overlay or a marketplace catalog that sources `plugin/`.

#### Scenario: Stale docs/cli.md fails the check

- **WHEN** `docs/cli.md` is edited by hand (or left unchanged after a registry/doc-metadata change) so it no longer matches a fresh generation
- **THEN** the docs generator check mode SHALL exit non-zero

#### Scenario: Fresh generation passes the check

- **WHEN** all generated CLI reference artifacts match a fresh generation run
- **THEN** the docs generator check mode SHALL exit zero for those artifacts

#### Scenario: CI invokes the staleness check when generator is present

- **WHEN** a contributor runs `npm run ci` from the repo root on a tree that contains `scripts/generate-docs.mjs`
- **THEN** the CLI reference staleness check SHALL run as part of that gate (via `ci:docs` / `docs:check` / `generate-docs.mjs --check`)

#### Scenario: SKILL staleness has one owning check

- **WHEN** any of the four committed host SKILLs differs from `renderHostSkill`
- **THEN** `node scripts/build.mjs --check` SHALL exit non-zero and name the stale path
- **AND** `scripts/generate-docs.mjs --check` SHALL NOT compare or require that SKILL

#### Scenario: absent plugin overlay is not a docs or SKILL check failure

- **WHEN** `plugin/` is absent and the four host SKILLs match a fresh generation
- **THEN** `node scripts/build.mjs --check` SHALL exit 0
- **AND** the docs generator check SHALL NOT require a plugin SKILL overlay
