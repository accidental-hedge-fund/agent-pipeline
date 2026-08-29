## MODIFIED Requirements

### Requirement: Host SKILLs SHALL document the operator-owned native `/goal` bootstrap sequence

Operator-facing docs (`docs/cli.md` and/or `docs/packaging.md`) SHALL describe the canonical, operator-owned bootstrap for starting a durable `pipeline loop` run as an explicit, ordered two-step: enter the host's native goal mode first and then invoke `pipeline loop`. Generated host SKILLs SHALL NOT be required to restate that essay. The documents SHALL present the same ordering and meaning without requiring generated per-verb command files.

#### Scenario: Claude host documents native goal mode then pipeline loop

- **WHEN** the operator-facing loop docs or the Claude host surface is read
- **THEN** the docs SHALL contain a bootstrap description that instructs the operator to enter the native `/goal` mode and then invoke `pipeline loop` for a durable run
- **AND** they SHALL present those two steps in that order
- **AND** the generated Claude SKILL SHALL NOT be required to restate that essay

#### Scenario: Codex host documents native goal mode then pipeline loop

- **WHEN** the operator-facing loop docs or the Codex host surface is read
- **THEN** the docs SHALL contain a bootstrap description that instructs the operator to enter the native goal mode and then invoke `pipeline loop` for a durable run
- **AND** they SHALL present those two steps in that order
- **AND** the generated Codex SKILL SHALL NOT be required to restate that essay

#### Scenario: The two host surfaces stay symmetric

- **WHEN** generated Claude, Codex, Grok, and OpenCode SKILLs are compared
- **THEN** they SHALL NOT each carry a different `/goal` bootstrap essay
- **AND** they SHALL name the same `pipeline loop` CLI invocation in the verb table

---

### Requirement: The bootstrap documentation SHALL disclaim host-state detection, recursive invocation, and lifecycle control

The bootstrap documentation in operator-facing docs SHALL state explicitly that the skill does **not** detect whether the host's native `/goal` mode is active, does **not** invoke or re-enter `/goal` itself, and does **not** control the native `/goal` session's lifecycle. The documentation SHALL frame the engine's `/goal` mode as the outer autonomous driver and `pipeline loop` as the durable workload it runs. Generated host SKILLs SHALL NOT be required to repeat those disclaimers as an essay.

#### Scenario: Docs deny host `/goal` state detection

- **WHEN** the operator-facing bootstrap documentation is read
- **THEN** it SHALL state that the skill does not detect the host's native `/goal` session state

#### Scenario: Docs deny recursive `/goal` invocation

- **WHEN** the operator-facing bootstrap documentation is read
- **THEN** it SHALL state that the skill does not itself invoke or re-enter the native `/goal` mode
- **AND** it SHALL place responsibility for entering `/goal` on the operator

#### Scenario: Docs deny native lifecycle control

- **WHEN** the operator-facing bootstrap documentation is read
- **THEN** it SHALL state that the skill does not control the native `/goal` session's lifecycle
