## ADDED Requirements

### Requirement: Stage inventory SSOT is the code STAGES and TERMINAL_STAGES constants
The authored source of truth for the pipeline stage inventory SHALL be the ordered `STAGES` constant and the `TERMINAL_STAGES` set exported from `core/scripts/types.ts`. Operator-facing and OpenSpec inventory surfaces SHALL describe that same inventory; they SHALL NOT invent a shorter stage list or a single-terminal model that contradicts those constants.

#### Scenario: Code constants remain the authority
- **WHEN** stage inventory is documented or asserted in living OpenSpec, host SKILL diagrams, README, or `openspec/project.md`
- **THEN** the documented stages and terminals SHALL match `STAGES` and `TERMINAL_STAGES` from `core/scripts/types.ts`
- **AND** those constants SHALL NOT be rewritten solely to match stale docs

### Requirement: Host SKILL diagrams SHALL list every STAGES member
`hosts/claude/SKILL.md` and `hosts/codex/SKILL.md` SHALL each present a state-machine inventory (diagram and/or ordered list) that includes every member of `STAGES`, including `plan-review`, `design-gate`, `visual-gate`, and `needs-human`. Stage-count language on those host surfaces (e.g. "N-stage") SHALL equal `STAGES.length`.

#### Scenario: Claude host diagram includes previously omitted stages
- **WHEN** `hosts/claude/SKILL.md` state-machine section is read
- **THEN** it SHALL name `plan-review`, `design-gate`, `visual-gate`, and `needs-human`
- **AND** it SHALL name every other member of `STAGES`

#### Scenario: Codex host diagram includes previously omitted stages
- **WHEN** `hosts/codex/SKILL.md` state-machine section is read
- **THEN** it SHALL name `plan-review`, `design-gate`, `visual-gate`, and `needs-human`
- **AND** it SHALL name every other member of `STAGES`

#### Scenario: Host stage-count language matches STAGES.length
- **WHEN** either host SKILL claims an "N-stage" (or equivalent) state machine in its inventory intro
- **THEN** N SHALL equal `STAGES.length`

### Requirement: README and openspec project.md stage-count language SHALL match STAGES
`README.md` and `openspec/project.md` SHALL NOT claim a stage count that differs from `STAGES.length`. Inventory intro language on those surfaces SHALL be consistent with the code stage list (including awareness that `needs-human` is a terminal off-ramp in `STAGES` / `TERMINAL_STAGES`).

#### Scenario: README inventory count matches code
- **WHEN** `README.md` states a numeric stage-machine size in its primary inventory blurb
- **THEN** that number SHALL equal `STAGES.length`

#### Scenario: project.md inventory count matches code
- **WHEN** `openspec/project.md` states a numeric stage-machine size in its purpose blurb
- **THEN** that number SHALL equal `STAGES.length`

### Requirement: Living OpenSpec spine inventory SHALL match code constants
The living `pipeline-state-machine` specification's STAGES-order scenario SHALL list every member of `STAGES` in the same order as the constant. Its terminal-stage requirement SHALL state that `TERMINAL_STAGES` contains exactly `ready-to-deploy` and `needs-human`.

#### Scenario: Living STAGES-order scenario includes needs-human
- **WHEN** the living `pipeline-state-machine` STAGES-order scenario is read
- **THEN** the ordered list SHALL end with `ready-to-deploy`, `needs-human` (after the other stages in code order)

#### Scenario: Living terminal requirement is dual-terminal
- **WHEN** the living `pipeline-state-machine` terminal-stage requirement is read
- **THEN** it SHALL require both `ready-to-deploy` and `needs-human` as members of `TERMINAL_STAGES`
- **AND** it SHALL NOT claim that `TERMINAL_STAGES` contains exactly `ready-to-deploy` alone

### Requirement: Drift-guard test fails on inventory divergence
A unit test in the core test suite SHALL compare code `STAGES` / `TERMINAL_STAGES` against the guarded inventory surfaces and fail when any surface diverges. Guarded surfaces SHALL include at least: the living `pipeline-state-machine` STAGES-order scenario text, the living terminal-stage membership claim, `hosts/claude/SKILL.md` and `hosts/codex/SKILL.md` stage-name coverage and stage-count language, `README.md` primary stage-count language, and `openspec/project.md` primary stage-count language.

#### Scenario: In-sync surfaces pass
- **WHEN** every guarded surface matches `STAGES` / `TERMINAL_STAGES`
- **THEN** the drift-guard test SHALL pass

#### Scenario: Missing stage in a host SKILL diagram fails
- **WHEN** a stage name present in `STAGES` is absent from a host SKILL state-machine inventory
- **THEN** the drift-guard test SHALL fail and identify the host file and missing stage

#### Scenario: Wrong stage-count language fails
- **WHEN** README, `openspec/project.md`, or a host SKILL claims a stage count other than `STAGES.length`
- **THEN** the drift-guard test SHALL fail and identify the surface and expected count

#### Scenario: Living STAGES-order omission fails
- **WHEN** the living STAGES-order scenario omits `needs-human` or any other `STAGES` member, or lists stages out of code order
- **THEN** the drift-guard test SHALL fail

#### Scenario: Living single-terminal claim fails
- **WHEN** the living terminal requirement claims `TERMINAL_STAGES` is exactly `{ready-to-deploy}` alone
- **THEN** the drift-guard test SHALL fail

### Requirement: Plugin mirror regenerated after host SKILL inventory edits
When `hosts/claude/SKILL.md` is updated as part of this inventory alignment, the implementer SHALL run `node scripts/build.mjs` and include the regenerated `plugin/` mirror in the same change so `build.mjs --check` passes.

#### Scenario: Claude host SKILL change includes plugin mirror
- **WHEN** `hosts/claude/SKILL.md` stage inventory is edited in this change
- **THEN** the same change SHALL include the regenerated `plugin/` content produced by `node scripts/build.mjs`
- **AND** `node scripts/build.mjs --check` SHALL pass
