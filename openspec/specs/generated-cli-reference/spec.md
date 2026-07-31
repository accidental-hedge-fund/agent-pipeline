# generated-cli-reference Specification

## Purpose
TBD - created by archiving change docs-generated-cli-config-reference. Update Purpose after archive.
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

The same generator (or a parameterized sibling using the same inventory) SHALL rewrite a clearly delimited generated region in both `hosts/claude/SKILL.md` and `hosts/codex/SKILL.md` so that both hosts list the same documented commands. The two surfaces SHALL differ only by host invocation token (`/pipeline` vs `$pipeline` or the host's documented equivalent), not by which commands are included.

#### Scenario: Both hosts list the same documented commands

- **WHEN** the generator rewrites the SKILL command-table regions for Claude and Codex
- **THEN** the set of documented command keywords in both regions SHALL be identical
- **AND** each region SHALL use only that host's invocation token form in usage lines

#### Scenario: Generated regions are delimited and regenerable

- **WHEN** a contributor inspects the host SKILL files after generation
- **THEN** each generated command-table region SHALL be bounded by stable begin/end markers so a subsequent generate run can replace the region without rewriting the rest of the file

---

### Requirement: Committed CLI reference artifacts SHALL be staleness-gated in CI

The repository SHALL provide a check mode for the CLI reference generator (for example `node scripts/generate-docs.mjs --check`) that exits non-zero when the committed `docs/cli.md` or either host SKILL generated command-table region differs from a fresh generation. That check SHALL be invoked from the root `npm run ci` gate (directly or via a composed docs-check step) so a stale committed reference fails CI the same way a stale `plugin/` mirror fails `build.mjs --check`.

#### Scenario: Stale docs/cli.md fails the check

- **WHEN** `docs/cli.md` is edited by hand (or left unchanged after a registry/doc-metadata change) so it no longer matches a fresh generation
- **THEN** the docs generator check mode SHALL exit non-zero

#### Scenario: Fresh generation passes the check

- **WHEN** all generated CLI reference artifacts match a fresh generation run
- **THEN** the docs generator check mode SHALL exit zero for those artifacts

#### Scenario: CI invokes the staleness check

- **WHEN** a contributor runs `npm run ci` from the repo root
- **THEN** the CLI reference staleness check SHALL run as part of that gate

