## MODIFIED Requirements

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
