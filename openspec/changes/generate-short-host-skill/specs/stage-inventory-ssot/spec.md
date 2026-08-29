## MODIFIED Requirements

### Requirement: Host SKILL surfaces SHALL document the full stage inventory including off-ramp stages

Operator-facing docs (`docs/cli.md` and/or `docs/concepts.md`) SHALL present a stage inventory that includes every mid-flight and gate stage operators need: at minimum `plan-review`, `design-gate`, `visual-gate`, and the terminal off-ramp `needs-human`, in addition to the happy-path stages through `ready-to-deploy`. Stage-count language SHALL NOT claim a count that contradicts `STAGES.length`. Generated host SKILLs SHALL NOT be required to repeat that inventory. Host SKILLs SHALL stay free of host-specific stage-machine logic.

#### Scenario: Claude host includes previously omitted stages

- **WHEN** the operator-facing docs that describe the stage machine are read
- **THEN** they SHALL name `plan-review`, `design-gate`, `visual-gate`, and `needs-human`
- **AND** they SHALL NOT claim a stage count that under-counts relative to code `STAGES`
- **AND** the generated Claude SKILL SHALL NOT be required to repeat that inventory

#### Scenario: Codex host includes previously omitted stages

- **WHEN** the operator-facing docs that describe the stage machine are read
- **THEN** they SHALL name `plan-review`, `design-gate`, `visual-gate`, and `needs-human`
- **AND** they SHALL NOT claim a stage count that under-counts relative to code `STAGES`
- **AND** the generated Codex SKILL SHALL NOT be required to repeat that inventory

#### Scenario: Host inventories stay symmetric

- **WHEN** generated Claude, Codex, Grok, and OpenCode SKILLs are compared
- **THEN** they SHALL NOT document different stage membership per host
- **AND** they SHALL differ only in host-specific command tokens or notify-tool names

---

### Requirement: A drift guard SHALL fail when stage-inventory surfaces diverge from code

A co-located unit test under `core/test/` SHALL assert that the stage-inventory surfaces stay aligned with code `STAGES` and `TERMINAL_STAGES`. The test SHALL perform no network, git, or subprocess calls. The test SHALL fail if any of the following diverge: operator-facing docs omission of required stages (`plan-review`, `design-gate`, `visual-gate`, `needs-human`); a stated stage count that is not `STAGES.length`; `openspec/project.md` under-count language; living `pipeline-state-machine` STAGES-order text missing any `STAGES` member or terminal-set text omitting `needs-human`. The test SHALL NOT fail solely because a generated short SKILL omits the stage-machine essay. The test SHALL bite (fail before the surfaces are corrected).

#### Scenario: Drift guard pins host skills against STAGES

- **WHEN** operator-facing docs drop `plan-review`, `design-gate`, `visual-gate`, or `needs-human` from the stage inventory
- **THEN** the drift-guard test SHALL fail
- **AND** the test SHALL NOT fail solely because a generated short SKILL omits the stage-machine essay

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

### Requirement: Generated Claude SKILL overlay SHALL carry the host stage inventory

After a generated Claude host SKILL is updated, the generated plugin SKILL overlay SHALL be regenerated with `node scripts/build.mjs` and committed in the same change so the remaining plugin shell receives the short SKILL. CI's `build.mjs --check` gate SHALL pass without a copied core tree. The overlay SHALL carry the generated one-pager, not a restored stage-machine essay.

#### Scenario: SKILL overlay check passes after host skill update

- **WHEN** `hosts/claude/SKILL.md` is regenerated
- **THEN** `node scripts/build.mjs` SHALL be run and the regenerated plugin SKILL overlay committed with the same change
- **AND** `node scripts/build.mjs --check` SHALL pass
