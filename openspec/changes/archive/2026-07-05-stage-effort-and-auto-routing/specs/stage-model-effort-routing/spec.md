## ADDED Requirements

### Requirement: The auto sentinel SHALL resolve to a concrete model and effort at config-load time

`resolveConfig()` SHALL treat the string `"auto"` as a valid value for any `models.*` or `effort.*` key and SHALL expand it, at config-load time, into a concrete `(model, effort)` pair via a fixed stage routing matrix. After resolution, no value read by stage code for a model or an effort SHALL equal the literal string `"auto"`. The routing matrix SHALL map each stage to a `(nature, permanence)` cell and thence to a `(model, effort)` pair:

- Mechanical × {Ephemeral, Iterative} → `gpt-5.5 / low`; Mechanical × Definitive → `sonnet / medium`.
- Analytical × Ephemeral → `sonnet / low`; Analytical × Iterative → `opus / medium`; Analytical × Definitive → `claude-fable-5 / high`.
- Adversarial × Ephemeral → `claude-fable-5 / medium`; Adversarial × Iterative → `claude-fable-5 / high`; Adversarial × Definitive → `claude-fable-5 / max`.

The stage classifications SHALL be: `intake`/`sweep` = Analytical/Ephemeral; `planning` = Analytical/Iterative; `implementing`/`fix-1`/`fix-2` = Mechanical/Iterative; `plan-review` = Adversarial/Definitive; `review-1` = Adversarial/Iterative; `review-2` = Adversarial/Definitive.

#### Scenario: auto accepted and resolved for an effort key

- **WHEN** `.github/pipeline.yml` sets `effort: { planning: auto }`
- **THEN** `resolveConfig()` SHALL return a resolved planning-stage effort of `"medium"` and SHALL NOT expose the literal `"auto"` to any stage

#### Scenario: auto accepted and resolved for a model key

- **WHEN** `.github/pipeline.yml` sets `models: { review: auto }`
- **THEN** `resolveConfig()` SHALL resolve the review-stage model to `"claude-fable-5"` and SHALL NOT expose the literal `"auto"` to any stage

#### Scenario: no literal auto escapes resolution

- **WHEN** any `models.*` or `effort.*` key is set to `"auto"`
- **THEN** the resolved `PipelineConfig` value consulted by stage code for that model or effort SHALL be a concrete string, never `"auto"`

### Requirement: Auto model resolution SHALL respect the stage harness assignment

`resolveAuto()` SHALL constrain the resolved model to one the stage's backing harness can run. For a Mechanical stage on the **claude** primary harness the resolved model SHALL be `sonnet` (not `gpt-5.5`, which is codex-only); on the **codex** primary harness it SHALL be `gpt-5.5`. Effort values SHALL NOT be remapped by harness.

#### Scenario: Mechanical/Iterative stage on claude primary resolves to sonnet

- **WHEN** the active profile is `claude` (implementer = claude) and `models.implementing` is `"auto"`
- **THEN** the resolved implementing model SHALL be `"sonnet"` and SHALL NOT be `"gpt-5.5"`

#### Scenario: Mechanical/Iterative stage on codex primary resolves to gpt-5.5

- **WHEN** the active profile is `codex` (implementer = codex) and `models.implementing` is `"auto"`
- **THEN** the resolved implementing model SHALL be `"gpt-5.5"`

#### Scenario: effort is not remapped by harness

- **WHEN** a Mechanical/Iterative stage resolves `auto` under either profile
- **THEN** the resolved effort SHALL be `"low"` regardless of which harness backs the stage

### Requirement: Adversarial-stage auto resolution SHALL be profile-independent and use the full fable model id

`resolveAuto()` SHALL resolve the model for every Adversarial stage (`plan-review`, `review-1`, `review-2`) to `claude-fable-5` regardless of the active profile. The resolved value SHALL be the full id `claude-fable-5` and SHALL NEVER be the short alias `fable-5` (which the Claude CLI does not recognize). Whether the resolved model is honored at runtime is governed by the existing inert-model advisory (an alternative harness of `codex` ignores claude model aliases); this requirement governs only the resolved value.

#### Scenario: Adversarial model identical across profiles

- **WHEN** `models.review` is `"auto"` under the `claude` profile, and separately under the `codex` profile
- **THEN** the resolved review model SHALL be `"claude-fable-5"` in both cases

#### Scenario: full fable id, never the short alias

- **WHEN** any Adversarial stage resolves `auto`
- **THEN** the resolved model SHALL equal `"claude-fable-5"` and SHALL NOT equal `"fable-5"`

### Requirement: The same auto effort key SHALL resolve per-stage, not once per key

`resolveConfig()` SHALL resolve an `auto` effort/model value using the classification of the concrete stage being routed, even when two stages of different classification share one config key. In particular, an `auto` value under `effort.planning` SHALL resolve the `planning` stage as Analytical/Iterative (`medium`) and the `plan-review` stage as Adversarial/Definitive (`max`).

#### Scenario: planning key auto splits across two stages

- **WHEN** `effort: { planning: auto }` is set
- **THEN** the resolved `planning`-stage effort SHALL be `"medium"`
- **AND** the resolved `plan-review`-stage effort SHALL be `"max"`

### Requirement: The claude harness invoke SHALL pass reasoning effort via an --effort flag

`invoke()` SHALL, when `harness === "claude"` and `reasoningEffort` is set, append `--effort <value>` to the claude CLI arguments. When `reasoningEffort` is absent, `invoke()` SHALL NOT add any effort flag. The codex path (`-c model_reasoning_effort=<value>`) and custom-reviewer-CLI path SHALL be unchanged by this requirement.

#### Scenario: claude invoke with effort

- **WHEN** `invoke("claude", dir, prompt, { reasoningEffort: "high" })` is called
- **THEN** the claude process arguments SHALL include `--effort high`

#### Scenario: claude invoke without effort

- **WHEN** `invoke("claude", dir, prompt, {})` is called with no `reasoningEffort`
- **THEN** the claude process arguments SHALL NOT include any `--effort` flag

#### Scenario: codex path unchanged

- **WHEN** `invoke("codex", dir, prompt, { reasoningEffort: "high" })` is called
- **THEN** the codex process arguments SHALL include `-c model_reasoning_effort=high` and SHALL NOT include `--effort`

### Requirement: Resolved per-stage effort SHALL be threaded to each stage invocation

Each stage's harness invocation SHALL pass its resolved effort as `reasoningEffort`. When a stage's resolved effort is absent (the config key is unset and not `auto`), the invocation SHALL omit `reasoningEffort` so no effort flag is emitted and the operator's global setting applies.

#### Scenario: explicit per-stage effort reaches the harness

- **WHEN** `effort: { implementing: low }` is set and the implementing stage runs
- **THEN** the implementing harness invocation SHALL pass `reasoningEffort: "low"`

#### Scenario: unset effort emits no flag

- **WHEN** the `effort:` block is absent from `.github/pipeline.yml` and a stage runs
- **THEN** that stage's harness invocation SHALL omit `reasoningEffort` and no effort flag SHALL be emitted
