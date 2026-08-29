## MODIFIED Requirements

### Requirement: Host SKILL command tables SHALL be fed from the same CLI inventory

The same generator (or a parameterized sibling using the same inventory) SHALL rewrite a clearly delimited generated region in `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`, `hosts/omp/SKILL.md`, and `hosts/opencode/SKILL.md` so that all four hosts list the same documented commands. The surfaces SHALL differ only by host invocation token (`/pipeline` vs `$pipeline` or the host's documented equivalent), not by which commands are included.

#### Scenario: All hosts list the same documented commands

- **WHEN** the generator rewrites the SKILL command-table regions for Claude, Codex, OMP, and OpenCode
- **THEN** the set of documented command keywords in all four regions SHALL be identical
- **AND** each region SHALL use only that host's invocation token form in usage lines

#### Scenario: Generated regions are delimited and regenerable

- **WHEN** a contributor inspects the host SKILL files after generation
- **THEN** each generated command-table region SHALL be bounded by stable begin/end markers so a subsequent generate run can replace the region without rewriting the rest of the file

### Requirement: Committed CLI reference artifacts SHALL be staleness-gated in CI

The repository SHALL provide a check mode for the CLI reference generator via `scripts/generate-docs.mjs --check` (or an equivalent `docs:check` script that invokes that check mode) that exits non-zero when the committed `docs/cli.md` or any of the four host SKILL generated command-table regions differs from a fresh generation. That check SHALL be reached from the root `npm run ci` gate through the existing conditional docs-freshness step (`ci:docs`) once the generator is present, so a stale committed reference fails CI the same way a stale generated SKILL/catalog output fails `build.mjs --check`.

#### Scenario: Stale docs/cli.md fails the check

- **WHEN** `docs/cli.md` is edited by hand (or left unchanged after a registry/doc-metadata change) so it no longer matches a fresh generation
- **THEN** the docs generator check mode SHALL exit non-zero

#### Scenario: Fresh generation passes the check

- **WHEN** all generated CLI reference artifacts match a fresh generation run
- **THEN** the docs generator check mode SHALL exit zero for those artifacts

#### Scenario: CI invokes the staleness check when generator is present

- **WHEN** a contributor runs `npm run ci` from the repo root on a tree that contains `scripts/generate-docs.mjs`
- **THEN** the CLI reference staleness check SHALL run as part of that gate (via `ci:docs` / `docs:check` / `generate-docs.mjs --check`)
