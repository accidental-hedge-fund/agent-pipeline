# generated-cli-reference Specification

## Purpose
TBD - created by archiving change docs-generate-cli-config-reference. Update Purpose after archive.

## Requirements

### Requirement: CLI reference documentation SHALL be generated from the command registry

The repository SHALL provide a deterministic generator that emits the human CLI reference document `docs/cli.md` from `COMMAND_REGISTRY` (and its co-located documentation metadata). Every registry command marked as documented SHALL appear in the generated reference with at least a usage synopsis and a one-line summary. Registry keywords marked undocumented or hidden SHALL NOT appear in the generated reference. The generator SHALL NOT invent commands that are absent from the registry.

#### Scenario: Documented command appears in docs/cli.md

- **WHEN** the CLI reference generator runs against a registry that includes a documented command entry with summary and usage metadata
- **THEN** `docs/cli.md` SHALL contain that command's usage synopsis and summary

#### Scenario: Hidden registry keyword is omitted

- **WHEN** a registry keyword is marked undocumented or hidden (for example a legacy alias retained only for dispatch)
- **THEN** the generated `docs/cli.md` SHALL NOT list that keyword as a recommended user-facing command

#### Scenario: Generator does not invent commands

- **WHEN** a string does not appear as a key in `COMMAND_REGISTRY`
- **THEN** the generator SHALL NOT emit a CLI reference entry for that string

---

### Requirement: Host SKILL command tables SHALL be fed from the same CLI inventory

`renderHostSkill` SHALL render the verb table that `scripts/build.mjs` writes to `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`, `hosts/grok/SKILL.md`, and `hosts/opencode/SKILL.md` so those four files list the same `OPERATION_SURFACE` verbs and are byte-identical. Usage lines SHALL invoke the installed product as `pipeline <verb>`; each `|` alternative SHALL be a complete `pipeline …` invocation. Host discovery tokens such as `/pipeline` and `$pipeline` SHALL NOT fork the CLI table. `scripts/build.mjs` SHALL be the only SKILL writer. The docs generator SHALL NOT read, require, or rewrite `hosts/omp/SKILL.md` or any other host SKILL. `docs/cli.md` SHALL remain the full documented CLI inventory from `COMMAND_REGISTRY` plus `OPERATION_SURFACE`.

#### Scenario: All hosts list the same documented commands

- **WHEN** the generator writes the SKILL verb tables for Claude, Codex, Grok, and OpenCode
- **THEN** the set of `OPERATION_SURFACE` verb names in all four tables SHALL be identical
- **AND** each table SHALL use the direct `pipeline <verb>` CLI form
- **AND** each `|` alternative SHALL begin with `pipeline`

#### Scenario: Generated regions are delimited and regenerable

- **WHEN** a contributor inspects the four generated host SKILL files after generation
- **THEN** each file SHALL match a fresh generation from `OPERATION_SURFACE` plus the shared orchestration-contract source
- **AND** a subsequent generate run SHALL be able to replace the whole SKILL without a leftover handwritten essay
- **AND** that generate run SHALL be `node scripts/build.mjs`, not the docs generator

#### Scenario: OMP is not a SKILL table target

- **WHEN** the CLI/SKILL generator runs
- **THEN** it SHALL NOT write or require `hosts/omp/SKILL.md`
- **AND** it SHALL NOT read or marker-check any host SKILL as an input
- **AND** `docs/cli.md` SHALL still list documented CLI verbs

---

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

### Requirement: Generated CLI reference SHALL publish executable `handoff` verb grammar

Command-docs metadata for the `handoff` registry keyword SHALL describe the executable operator grammar for `list`, `show`, `answer`, `reject`, and `supersede`. Generated `docs/cli.md` SHALL include those forms as complete `pipeline …` usage alternatives. The published grammar SHALL name the real flags used by dispatch, including `--filter-status` for list, and SHALL NOT present `--status` as a handoff list filter. The published grammar SHALL NOT document a module-invocation workaround as the operator path.

#### Scenario: Each documented verb has an executable usage alternative

- **WHEN** the CLI reference generator runs against current command-docs
- **THEN** `docs/cli.md` SHALL include complete `pipeline handoff list`, `pipeline handoff show <handoff-id>`, `pipeline handoff answer <handoff-id>`, `pipeline handoff reject <handoff-id>`, and `pipeline handoff supersede <handoff-id>` usage alternatives

#### Scenario: Docs name executable flags, not a workaround

- **WHEN** an operator reads the generated `handoff` usage in `docs/cli.md`
- **THEN** the text SHALL NOT instruct the operator to invoke the handoff module directly
- **AND** list-filter usage SHALL name `--filter-status`, not `--status`

### Requirement: Generated CLI reference SHALL publish executable `grill` selector grammar from one source

Command-docs metadata and `OPERATION_SURFACE` for the `grill` registry keyword SHALL describe the executable operator grammar for `--issue N`, `--issues N,N,...`, `--milestone M`, repeated `--label L`, `--dry-run`, `status`, `--follow`, and `--resume`. Generated `docs/cli.md` and host SKILL verb tables SHALL include those forms as complete `pipeline …` usage alternatives from that same metadata. The published grammar SHALL NOT invent a second selector DSL and SHALL NOT document a host Skill tool as the operator path.

#### Scenario: docs/cli.md lists the four selector forms

- **WHEN** the CLI reference generator runs after `grill` is registered
- **THEN** `docs/cli.md` SHALL include `pipeline grill --issue`, `pipeline grill --issues`, `pipeline grill --milestone`, and `pipeline grill --label`
- **AND** SHALL include dry-run and status/follow usage

#### Scenario: Host SKILL tables match the registry grammar

- **WHEN** `node scripts/build.mjs` writes the four host SKILL files
- **THEN** each SKILL verb table SHALL list the same `grill` usage alternatives as `OPERATION_SURFACE`
- **AND** each alternative SHALL begin with `pipeline grill`
