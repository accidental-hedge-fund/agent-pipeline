## MODIFIED Requirements

### Requirement: Host SKILL command tables SHALL be fed from the same CLI inventory

The same generator (or a parameterized sibling using `OPERATION_SURFACE`) SHALL write the verb table in `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`, `hosts/grok/SKILL.md`, and `hosts/opencode/SKILL.md` so that those four hosts list the same `OPERATION_SURFACE` verbs. The surfaces SHALL differ only by host invocation token (`/pipeline` vs `$pipeline` vs `pipeline` or the host's documented equivalent), not by which operation-surface verbs are included. The generator SHALL NOT rewrite `hosts/omp/SKILL.md`. `docs/cli.md` SHALL remain the full documented CLI inventory from `COMMAND_REGISTRY` plus `OPERATION_SURFACE`.

#### Scenario: All hosts list the same documented commands

- **WHEN** the generator writes the SKILL verb tables for Claude, Codex, Grok, and OpenCode
- **THEN** the set of `OPERATION_SURFACE` verb names in all four tables SHALL be identical
- **AND** each table SHALL use only that host's invocation token form in usage lines

#### Scenario: Generated regions are delimited and regenerable

- **WHEN** a contributor inspects the four generated host SKILL files after generation
- **THEN** each file SHALL match a fresh generation from `OPERATION_SURFACE` plus the shared orchestration-contract source
- **AND** a subsequent generate run SHALL be able to replace the whole SKILL without a leftover handwritten essay

#### Scenario: OMP is not a SKILL table target

- **WHEN** the CLI/SKILL generator runs
- **THEN** it SHALL NOT write or require `hosts/omp/SKILL.md`
- **AND** `docs/cli.md` SHALL still list documented CLI verbs

---

### Requirement: Committed CLI reference artifacts SHALL be staleness-gated in CI

The repository SHALL provide a check mode for the CLI reference generator via `scripts/generate-docs.mjs --check` (or an equivalent `docs:check` script that invokes that check mode) that exits non-zero when the committed `docs/cli.md` differs from a fresh generation. Generated host SKILL freshness SHALL be gated by the same docs check or by `build.mjs --check` for the four SKILL hosts (Claude, Codex, Grok, OpenCode). That check SHALL be reached from the root `npm run ci` gate through the existing conditional docs-freshness step (`ci:docs`) once the generator is present, so a stale committed reference fails CI the same way a stale generated SKILL/catalog output fails `build.mjs --check`.

#### Scenario: Stale docs/cli.md fails the check

- **WHEN** `docs/cli.md` is edited by hand (or left unchanged after a registry/doc-metadata change) so it no longer matches a fresh generation
- **THEN** the docs generator check mode SHALL exit non-zero

#### Scenario: Fresh generation passes the check

- **WHEN** all generated CLI reference artifacts match a fresh generation run
- **THEN** the docs generator check mode SHALL exit zero for those artifacts

#### Scenario: CI invokes the staleness check when generator is present

- **WHEN** a contributor runs `npm run ci` from the repo root on a tree that contains `scripts/generate-docs.mjs`
- **THEN** the CLI reference staleness check SHALL run as part of that gate (via `ci:docs` / `docs:check` / `generate-docs.mjs --check`)
