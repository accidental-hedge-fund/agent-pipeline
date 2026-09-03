# stage-inventory-ssot Specification

## Purpose
TBD - created by archiving change single-source-stages-inventory. Update Purpose after archive.

## Requirements

### Requirement: Code STAGES and TERMINAL_STAGES are the single source of truth for stage inventory surfaces

The ordered `STAGES` constant and `TERMINAL_STAGES` set in `core/scripts/types.ts` SHALL remain the sole source of truth for stage membership, order, count, and terminal outcomes. README, durable operator docs, project context, living specs, diagrams, and tests that describe the inventory SHALL match those code constants. Generated host SKILLs SHALL remain compact verb/follow one-pagers that link to the durable docs rather than cache the full stage list. This requirement SHALL NOT change runtime stage membership, order, or handler behavior.

#### Scenario: Code inventory is authoritative

- **WHEN** a durable documentation, diagram, project-context, or living OpenSpec surface describes the pipeline stages or terminal set
- **THEN** its membership and order SHALL match code `STAGES` and its terminal membership SHALL match `TERMINAL_STAGES`
- **AND** any numeric count SHALL equal `STAGES.length`

#### Scenario: Runtime inventory is unchanged by this capability

- **WHEN** the short host one-pager and durable stage docs are generated or updated
- **THEN** code `STAGES` membership and order SHALL remain unchanged, including `needs-human` after `ready-to-deploy`
- **AND** code `TERMINAL_STAGES` SHALL remain exactly `{ready-to-deploy, needs-human}`

---

### Requirement: README and openspec project context SHALL align stage-count language with code

`README.md` and `openspec/project.md` SHALL describe the stage inventory consistently with code `STAGES`. Neither file SHALL state an under-count or over-count, and any numeric count SHALL equal `STAGES.length`. When either surface describes terminal outcomes, it SHALL include `needs-human` as the compatibility park off-ramp alongside `ready-to-deploy`. Those surfaces SHALL state that `needs-human` projects a current typed-input wait and SHALL NOT describe mechanical exhaustion as lifecycle-terminal human ownership. The generated one-pager SHALL link to durable operator docs and SHALL NOT be required to repeat README or project-context inventory prose.

#### Scenario: README does not under-count stages

- **WHEN** `README.md` states a numeric stage count
- **THEN** that count SHALL equal `STAGES.length`
- **AND** lifecycle prose describing terminal outcomes SHALL include the `needs-human` park path
- **AND** that prose SHALL NOT treat mechanical exhaustion as human-owned cancellation

#### Scenario: openspec project context does not under-count stages

- **WHEN** `openspec/project.md` describes stage-machine size or inventory
- **THEN** any numeric count SHALL equal `STAGES.length`
- **AND** it SHALL NOT retain historical 11-, 13-, 15-, 16-, or 17-stage under-count language

---

### Requirement: A drift guard SHALL fail when stage-inventory surfaces diverge from code

A co-located unit test under `core/test/` SHALL import `STAGES` and `TERMINAL_STAGES` and fail when the durable operator inventory, README count, `openspec/project.md`, or living `pipeline-state-machine` order/terminal text diverges from those constants. The guard SHALL verify at least `plan-review`, `design-gate`, `visual-gate`, and `needs-human` on the durable inventory surface and SHALL fail on an incorrect numeric count. It SHALL NOT require or restore the full inventory in a generated host SKILL; generated-output freshness and byte-identity tests SHALL separately guard the compact one-pagers. The stage drift test SHALL perform no network, git, or subprocess calls and SHALL bite before mismatched durable surfaces are corrected.

#### Scenario: Drift guard pins host skills against STAGES

- **WHEN** the durable operator stage inventory drops `plan-review`, `design-gate`, `visual-gate`, or `needs-human`
- **THEN** the stage-inventory drift guard SHALL fail
- **AND** it SHALL NOT fail solely because a generated short SKILL omits the stage-machine essay

#### Scenario: Drift guard pins stage counts

- **WHEN** `README.md`, `openspec/project.md`, or the durable inventory states a numeric count unequal to `STAGES.length`
- **THEN** the drift-guard test SHALL fail

#### Scenario: Drift guard pins living spine order and terminals

- **WHEN** the living `pipeline-state-machine` STAGES-order scenario omits or reorders a code stage, or its terminal requirement omits `needs-human`
- **THEN** the drift-guard test SHALL fail

#### Scenario: Drift guard uses no external I/O

- **WHEN** the drift-guard test runs
- **THEN** it SHALL read local checked-in files and import code constants only
- **AND** it SHALL NOT perform network, git, or subprocess calls

---

### Requirement: Durable operator docs SHALL document the full stage inventory including off-ramp stages

Operator-facing durable documentation (`README.md`, `docs/concepts.md`, `docs/cli.md`, and/or another durable stage reference linked from the one-pager) SHALL present the complete code-derived stage inventory, including `plan-review`, `pre-code-attestation`, `design-gate`, `visual-gate`, `eval-gate`, `shipcheck-gate`, `ready-to-deploy`, and the compatibility off-ramp `needs-human`. The documented order, count, and label-terminal membership SHALL match `STAGES` and `TERMINAL_STAGES`. Those docs SHALL distinguish label-inventory terminals from RecoverySupervisor lifecycle states: `needs-human` is a compatibility projection of a current typed-input wait, not lifecycle cancellation, and mechanical exhaustion is Cooling. Generated Claude, Codex, Grok, and OpenCode SKILLs SHALL be byte-identical compact one-pagers with a durable-doc pointer and SHALL NOT reproduce the stage-machine inventory or host-specific stage logic.

#### Scenario: Claude host includes previously omitted stages

- **WHEN** an operator reaches the durable stage documentation from the generated Claude one-pager
- **THEN** the docs SHALL include `plan-review`, `design-gate`, `visual-gate`, and `needs-human` in their code-derived inventory
- **AND** the Claude one-pager SHALL NOT be required to repeat that inventory

#### Scenario: Codex host includes previously omitted stages

- **WHEN** an operator reaches the durable stage documentation from the generated Codex one-pager
- **THEN** the docs SHALL include `plan-review`, `design-gate`, `visual-gate`, and `needs-human` in their code-derived inventory
- **AND** the Codex one-pager SHALL NOT be required to repeat that inventory

#### Scenario: Host inventories stay symmetric

- **WHEN** generated Claude, Codex, Grok, and OpenCode SKILLs are compared
- **THEN** all four files SHALL be byte-identical and point to the same durable stage reference
- **AND** none SHALL contain a divergent host-specific stage inventory

#### Scenario: Docs do not call mechanical exhaustion human-owned

- **WHEN** durable operator docs describe `needs-human`
- **THEN** they SHALL identify it as a compatibility projection of a current typed request
- **AND** SHALL NOT instruct operators that retry exhaustion or unknown failure parks as human ownership

### Requirement: Host SKILL regeneration SHALL NOT write a plugin overlay

After `hosts/claude/SKILL.md` is regenerated from `renderHostSkill()`, `node scripts/build.mjs` SHALL NOT write a plugin SKILL overlay. CI's `node scripts/build.mjs --check` gate SHALL pass without a `plugin/` tree. The compact one-pager SHALL remain on the four generated host SKILLs.

#### Scenario: Host skill update does not recreate plugin/

- **WHEN** `hosts/claude/SKILL.md` is regenerated as the compact one-pager
- **THEN** `node scripts/build.mjs` SHALL NOT write `plugin/pipeline/skills/pipeline/SKILL.md`
- **AND** `node scripts/build.mjs --check` SHALL pass while `plugin/` is absent
