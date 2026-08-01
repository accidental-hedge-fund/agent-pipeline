## ADDED Requirements

### Requirement: Code STAGES and TERMINAL_STAGES are the single source of truth for stage inventory surfaces
The ordered constant `STAGES` and the set `TERMINAL_STAGES` in `core/scripts/types.ts` SHALL be the sole source of truth for the pipeline's stage inventory. Operator-facing and agent-facing surfaces that describe the stage list, stage count, state-machine diagram, or terminal set SHALL NOT invent a conflicting inventory. This requirement does not change runtime stage membership or handler behavior; it governs documentation and living-spine alignment only.

#### Scenario: Code inventory is authoritative
- **WHEN** a documentation or living OpenSpec surface describes the pipeline stage list or terminal set
- **THEN** that description SHALL match the membership and order of code `STAGES` and the membership of code `TERMINAL_STAGES`
- **AND** the surface SHALL NOT claim a stage count that under-counts or over-counts relative to `STAGES.length` when a numeric count is stated

#### Scenario: Runtime inventory is unchanged by this capability
- **WHEN** this capability is implemented
- **THEN** code `STAGES` membership and order SHALL remain the pre-change code truth (including `needs-human` after `ready-to-deploy`)
- **AND** code `TERMINAL_STAGES` SHALL remain exactly `{ready-to-deploy, needs-human}`

---

### Requirement: Host SKILL surfaces SHALL document the full stage inventory including off-ramp stages
Both `hosts/claude/SKILL.md` and `hosts/codex/SKILL.md` SHALL present a state-machine diagram or equivalent stage inventory that includes every mid-flight and gate stage operators need: at minimum `plan-review`, `design-gate`, `visual-gate`, and the terminal off-ramp `needs-human`, in addition to the happy-path stages through `ready-to-deploy`. Stage-count language on either host SHALL NOT claim a count that contradicts `STAGES.length`. The two hosts SHALL stay inventory-symmetric (same stages and off-ramp meaning; only host command tokens may differ).

#### Scenario: Claude host includes previously omitted stages
- **WHEN** the Claude host SKILL documentation state-machine section is read
- **THEN** it SHALL name `plan-review`, `design-gate`, `visual-gate`, and `needs-human`
- **AND** it SHALL NOT claim a stage count that under-counts relative to code `STAGES`

#### Scenario: Codex host includes previously omitted stages
- **WHEN** the Codex host SKILL documentation state-machine section is read
- **THEN** it SHALL name `plan-review`, `design-gate`, `visual-gate`, and `needs-human`
- **AND** it SHALL NOT claim a stage count that under-counts relative to code `STAGES`

#### Scenario: Host inventories stay symmetric
- **WHEN** the Claude and Codex stage inventories are compared
- **THEN** they SHALL document the same stage membership and the same terminal off-ramp meaning for `needs-human`
- **AND** they SHALL differ only in host-specific command tokens or packaging, not in stage inventory

---

### Requirement: README and openspec project context SHALL align stage-count language with code
`README.md` and `openspec/project.md` SHALL describe the pipeline stage inventory consistently with code `STAGES`. Neither file SHALL claim an “11-stage”, “13-stage”, or “15-stage” machine (or any other under-count) while code `STAGES` has sixteen members including `needs-human`. When a numeric stage count is stated, it SHALL equal `STAGES.length`.

#### Scenario: README does not under-count stages
- **WHEN** `README.md` states a numeric stage count for the state machine
- **THEN** that count SHALL equal the length of code `STAGES`
- **AND** the surrounding lifecycle prose SHALL NOT omit `needs-human` as a terminal park path when describing terminal outcomes

#### Scenario: openspec project context does not under-count stages
- **WHEN** `openspec/project.md` describes the stage machine size or inventory
- **THEN** it SHALL NOT claim an 11-stage machine
- **AND** any numeric stage count it states SHALL equal the length of code `STAGES`

---

### Requirement: A drift guard SHALL fail when stage-inventory surfaces diverge from code
A co-located unit test under `core/test/` SHALL assert that the stage-inventory surfaces stay aligned with code `STAGES` and `TERMINAL_STAGES`. The test SHALL perform no network, git, or subprocess calls. The test SHALL fail if any of the following diverge: host SKILL omission of required stages (`plan-review`, `design-gate`, `visual-gate`, `needs-human`); a stated stage count that is not `STAGES.length`; `openspec/project.md` under-count language; living `pipeline-state-machine` STAGES-order text missing any `STAGES` member or terminal-set text omitting `needs-human`. The test SHALL bite (fail before the surfaces are corrected).

#### Scenario: Drift guard pins host skills against STAGES
- **WHEN** either host SKILL drops `plan-review`, `design-gate`, `visual-gate`, or `needs-human` from its state-machine inventory
- **THEN** the drift-guard test SHALL fail

#### Scenario: Drift guard pins stage counts
- **WHEN** `README.md` or `openspec/project.md` states a numeric stage count that is not equal to `STAGES.length`
- **THEN** the drift-guard test SHALL fail

#### Scenario: Drift guard pins living spine order and terminals
- **WHEN** the living `pipeline-state-machine` STAGES-order scenario omits any member of code `STAGES`, or the living terminal requirement omits `needs-human` from `TERMINAL_STAGES`
- **THEN** the drift-guard test SHALL fail

#### Scenario: Drift guard uses no external I/O
- **WHEN** the drift-guard test runs
- **THEN** it SHALL read only local repository files and import code constants
- **AND** it SHALL NOT perform network, git, or subprocess calls

---

### Requirement: Plugin mirror SHALL carry the Claude host stage inventory
After the Claude host SKILL stage inventory is updated, the generated `plugin/` mirror SHALL be regenerated with `node scripts/build.mjs` and committed in the same change so installs receive the corrected inventory. CI's `build.mjs --check` gate SHALL pass.

#### Scenario: Mirror check passes after host skill update
- **WHEN** `hosts/claude/SKILL.md` is updated for stage inventory alignment
- **THEN** `node scripts/build.mjs` SHALL be run and the regenerated `plugin/` content committed with the same change
- **AND** `node scripts/build.mjs --check` SHALL pass
