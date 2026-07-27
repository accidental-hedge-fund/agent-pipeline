## MODIFIED Requirements

### Requirement: Auto model resolution SHALL respect the stage harness assignment

`resolveAuto()` SHALL constrain the resolved model to one the stage's backing harness can run, where the backing harness is the **resolved role harness** for that stage — the resolved implementer for implementer-role stages and the resolved reviewer for reviewer-role stages — and not the active profile's harness. Resolution SHALL support any registered harness adapter, not only the two built-in harnesses: for a Mechanical stage the resolved model SHALL be one the backing harness can run, so on the **claude** primary it SHALL be `sonnet` (not `gpt-5.5`, which is codex-only), on the **codex** primary it SHALL be `gpt-5.5`, and on any other registered primary it SHALL be a model that harness can run and SHALL NOT be an alias exclusive to a different harness. A backing harness for which no runnable model is known SHALL resolve to no model rather than to another harness's alias, leaving the harness's own default in effect. Effort values SHALL NOT be remapped by harness.

#### Scenario: Mechanical/Iterative stage on claude primary resolves to sonnet

- **WHEN** the resolved implementer is `claude` and `models.implementing` is `"auto"`
- **THEN** the resolved implementing model SHALL be `"sonnet"` and SHALL NOT be `"gpt-5.5"`

#### Scenario: Mechanical/Iterative stage on codex primary resolves to gpt-5.5

- **WHEN** the resolved implementer is `codex` and `models.implementing` is `"auto"`
- **THEN** the resolved implementing model SHALL be `"gpt-5.5"`

#### Scenario: Resolution follows repository role config over the profile

- **WHEN** the active profile's implementer is `claude`, the repository declares `harnesses: { implementer: codex }`, and `models.implementing` is `"auto"`
- **THEN** the resolved implementing model SHALL be the one the `codex` harness can run and SHALL NOT be `"sonnet"`

#### Scenario: A non-built-in primary never receives another harness's exclusive alias

- **WHEN** the resolved implementer is a registered adapter that is neither `claude` nor `codex` (for example `grok`) and `models.implementing` is `"auto"`
- **THEN** the resolved implementing model SHALL NOT be `"sonnet"` or any other alias exclusive to a different harness
- **AND** it SHALL be either a model that harness can run or no model at all

#### Scenario: effort is not remapped by harness

- **WHEN** a Mechanical/Iterative stage resolves `auto` under any resolved implementer
- **THEN** the resolved effort SHALL be `"low"` regardless of which harness backs the stage
