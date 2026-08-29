## REMOVED Requirements

### Requirement: This slice SHALL not change engine, install, SKILL.md, or plugin/ deletion behavior

**Reason:** This was the #1047 documentation slice's temporary scope boundary. Issue #1048 intentionally changes build, install, and host-packaging behavior, so retaining the boundary as a living product requirement would contradict the CLI-only packaging migration.

**Migration:** Issue #1050 remains the owner of whole-tree `plugin/` deletion, and #1049 remains the owner of the short host-SKILL rewrite. Runtime and installer behavior introduced here is governed by `cli-host-provision`.

## MODIFIED Requirements

### Requirement: Contributor docs SHALL present install CLI plus short SKILL, not copy core

Contributor-facing packaging docs (at least `docs/packaging.md`, and README Development when it speaks about how the product is consumed) SHALL present the contributor path as installing the `pipeline` CLI plus a short host SKILL that execs that CLI. Those docs SHALL NOT present copying `core/` into a committed plugin mirror, or treating the committed `plugin/` directory, as the product distribution. Until issue #1050 removes the remaining plugin shell, docs MAY name its generated SKILL/catalog outputs and `build.mjs --check` freshness gate, but SHALL NOT describe it as a core mirror or as the product.

#### Scenario: Contributor path names CLI plus SKILL

- **WHEN** a contributor reads `docs/packaging.md` for how to consume the product
- **THEN** the page SHALL tell them to install the CLI and a short host SKILL
- **AND** it SHALL NOT tell them to copy `core/` as the product

#### Scenario: plugin/ is transitional, not the product

- **WHEN** `docs/packaging.md` mentions `plugin/`
- **THEN** it SHALL describe `plugin/` as a generated SKILL/catalog shell scheduled for deletion in #1050
- **AND** it SHALL NOT describe `plugin/` as the distribution product

### Requirement: AGENTS.md and CLAUDE.md golden rule 1 SHALL name CLI plus SKILL as the product

Repo-root `AGENTS.md` and `CLAUDE.md` golden rule #1 SHALL state that the product is the `pipeline` CLI plus a short host SKILL. Those files SHALL NOT state “always commit the regenerated `plugin/` core mirror” as the packaging rule. They SHALL describe `node scripts/build.mjs --check` as a generated SKILL/catalog freshness gate. `AGENTS.md` and `CLAUDE.md` SHALL stay in sync on this rule.

#### Scenario: AGENTS.md no longer states the forever mirror rule

- **WHEN** a contributor reads `AGENTS.md` golden rule #1
- **THEN** the rule SHALL name CLI plus SKILL as the product
- **AND** it SHALL NOT say always commit `plugin/` as the forever rule
- **AND** it SHALL state that `build.mjs --check` asserts SKILL/catalog freshness

#### Scenario: CLAUDE.md matches AGENTS.md

- **WHEN** a contributor compares repo-root `CLAUDE.md` golden rule #1 with `AGENTS.md` golden rule #1
- **THEN** both files SHALL name CLI plus SKILL as the product
- **AND** both SHALL carry the same SKILL/catalog freshness instruction

### Requirement: openspec/project.md SHALL not claim Claude-plus-Codex-only or forever mirror commit

`openspec/project.md` SHALL describe the product as the `pipeline` CLI with host shims. It SHALL NOT state that the product ships only for Claude Code and Codex. It SHALL NOT require a regenerated `plugin/` core mirror. It MAY mention `build.mjs --check` only as a generated SKILL/catalog freshness gate.

#### Scenario: project.md is not Claude-plus-Codex-only

- **WHEN** a reader opens `openspec/project.md`
- **THEN** the file SHALL NOT say the product ships only as a Claude Code and Codex skill pair
- **AND** it SHALL describe hosts as wrappers around the CLI

#### Scenario: project.md is not forever-mirror

- **WHEN** a reader opens `openspec/project.md`
- **THEN** the file SHALL NOT say always commit regenerated `plugin/` as the forever packaging rule
