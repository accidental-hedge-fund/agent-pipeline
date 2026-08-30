## MODIFIED Requirements

### Requirement: Generator SHALL emit four short host SKILLs from the shared source

`scripts/build.mjs` SHALL be the sole writer and freshness checker for the `hosts/<id>/SKILL.md` targets derived from `SKILL_HOST_IDS`, which SHALL resolve exactly to `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`, `hosts/grok/SKILL.md`, and `hosts/opencode/SKILL.md`. It SHALL write all four from one call contract through `renderHostSkill`; the four files SHALL be byte-identical. Its write and check target sets SHALL be derived from the same tuple, and a drift guard SHALL fail if ID, rendered-row, write-target, or check-target membership differs. Each SKILL SHALL retain the default numeric issue/PR drive as `pipeline <N>`, tell hosts to execute catalog operations as `pipeline <verb>`, and contain the same compact manifest-derived notify map. They SHALL NOT encode host-specific stage-machine logic. The generator SHALL NOT write `/pipeline:*` markdown command files or Codex `$pipeline:*` yaml agents. The generator SHALL NOT write `plugin/pipeline/skills/pipeline/SKILL.md` or any other path under `plugin/`. `core/scripts/docs-generate.ts` and `scripts/generate-docs.mjs` SHALL NOT read, require, rewrite, or emit any host SKILL.

#### Scenario: Four generated SKILLs exist

- **WHEN** the generator runs on a complete tree
- **THEN** it SHALL write `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`, `hosts/grok/SKILL.md`, and `hosts/opencode/SKILL.md`
- **AND** each file SHALL be produced from the shared source plus `OPERATION_SURFACE`

#### Scenario: Host ID and target membership cannot drift

- **WHEN** generated notify rows, build write targets, and build check targets are enumerated
- **THEN** each set SHALL correspond one-to-one with `SKILL_HOST_IDS`
- **AND** no separately maintained target list SHALL admit OMP or omit a selected host
- **AND** write and check target sets SHALL NOT include a `plugin/` path

#### Scenario: Hosts share one contract

- **WHEN** the four generated SKILL bodies are compared byte-for-byte
- **THEN** they SHALL be identical and carry the same verb set and follow/notify obligations
- **AND** they SHALL NOT contain different stage lists, stage handlers, or stage-order rules per host

#### Scenario: Generator does not emit command packs

- **WHEN** the generator or `scripts/build.mjs` runs
- **THEN** it SHALL NOT write `plugin/pipeline/commands/pipeline:<verb>.md`
- **AND** it SHALL NOT write Codex `pipeline-<verb>.yaml` command agents from `OPERATION_SURFACE`

#### Scenario: Plugin output calls the same renderer directly

- **WHEN** `scripts/build.mjs` runs
- **THEN** it SHALL NOT write `plugin/pipeline/skills/pipeline/SKILL.md`
- **AND** it SHALL NOT create a `plugin/` directory
- **AND** host SKILL generation SHALL consume `renderHostSkill` directly

#### Scenario: Docs generation has no SKILL lifecycle

- **WHEN** `scripts/generate-docs.mjs` runs in write or check mode
- **THEN** it SHALL NOT read, require, compare, or write any host SKILL
- **AND** it SHALL NOT check for `hosts/omp/SKILL.md` or generated table markers

### Requirement: Tests SHALL pin generated SKILL freshness and forbid host-specific stage logic

A co-located unit test SHALL fail when any committed generated host SKILL differs from a fresh generation. A co-located unit test SHALL fail when a generated SKILL encodes host-specific stage-machine logic, when a rendered notify row differs from an injected outer-host manifest fixture, when a selected manifest ID is missing or duplicated, or when `SKILL_HOST_IDS` differs from rendered-row or build-target membership. A co-located unit test SHALL fail when the generator writes a per-verb slash-command or yaml-agent file. A co-located unit test SHALL fail when the generator writes any path under `plugin/`. Hook staging tests and eval fixture-boundary tests SHALL account for all four host SKILL outputs by exact path. Those tests SHALL perform no network, git, or subprocess calls beyond existing isolated hook fixtures and in-process generation.

#### Scenario: Stale generated SKILL fails

- **WHEN** a committed `hosts/claude/SKILL.md` (or Codex, Grok, or OpenCode peer) differs from a fresh generation
- **THEN** the freshness test SHALL fail

#### Scenario: Host-specific stage logic fails

- **WHEN** one generated SKILL names a stage list or stage handler that another generated SKILL omits or contradicts
- **THEN** the host-parity test SHALL fail

#### Scenario: Command-file generation fails the guard

- **WHEN** the generator would write a `pipeline:<verb>.md` or Codex `pipeline-<verb>.yaml` command file
- **THEN** the command-pack test SHALL fail

#### Scenario: Plugin overlay generation fails the guard

- **WHEN** the generator would write `plugin/pipeline/skills/pipeline/SKILL.md`
- **THEN** the plugin-directory test SHALL fail

#### Scenario: Manifest and render drift fails

- **WHEN** a host manifest's notify `surface`, `tools`, or `filter` differs from the generated notify row
- **THEN** the manifest/render parity test SHALL fail

#### Scenario: Manifest selection and target drift fail

- **WHEN** a selected manifest is missing or duplicated, or the rendered row and build target sets differ from `SKILL_HOST_IDS`
- **THEN** generation or the set-parity test SHALL fail before stale output is accepted

#### Scenario: Hook and eval accounting cover all four outputs

- **WHEN** build inputs can change generated host SKILL bytes
- **THEN** the pre-commit hook SHALL stage all four host SKILL paths by exact name
- **AND** eval generated-packaging accounting SHALL recognize and require those same four exact outputs
- **AND** neither boundary SHALL use a broad `hosts/` or `plugin/` allowance
