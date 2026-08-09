# stage-model-effort-routing Specification

## Purpose
TBD - created by archiving change stage-effort-and-auto-routing. Update Purpose after archive.
## Requirements
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

### Requirement: The codex harness invoke SHALL pass a configured model via a `-m` flag

`invoke()` SHALL, when `harness === "codex"` and `opts.model` is set, append `-m <value>` to the codex CLI arguments. When `opts.model` is absent, `invoke()` SHALL NOT add any `-m` flag. This model passthrough is independent of and composes with the existing effort passthrough (`-c model_reasoning_effort=<value>`). The claude path (`--model <value>`) and custom-reviewer-CLI path SHALL be unchanged by this requirement.

#### Scenario: codex invoke with a model

- **WHEN** `invoke("codex", dir, prompt, { model: "gpt-5.6-terra" })` is called
- **THEN** the codex process arguments SHALL include `-m gpt-5.6-terra`

#### Scenario: codex invoke without a model

- **WHEN** `invoke("codex", dir, prompt, {})` is called with no `model`
- **THEN** the codex process arguments SHALL NOT include any `-m` flag

#### Scenario: codex invoke composes model and effort

- **WHEN** `invoke("codex", dir, prompt, { model: "gpt-5.6-terra", reasoningEffort: "high" })` is called
- **THEN** the codex process arguments SHALL include both `-m gpt-5.6-terra` and `-c model_reasoning_effort=high`

### Requirement: Auto model resolution for a codex reviewer SHALL NOT emit a claude-only alias

When the effective reviewer command is `codex` and a reviewer model is produced by expanding the `"auto"` sentinel, the resolution SHALL NOT hand a claude-only alias to the codex invocation. Because every Adversarial routing cell (`plan-review`, `review-1`, `review-2`) resolves `auto` to `claude-fable-5` — a claude-only alias with no codex equivalent in the routing matrix — the resolution SHALL omit the model (no `-m` flag; codex uses its configured default) rather than forward the claude-only alias. This requirement governs only the `auto` case for a codex reviewer; an explicit (non-`auto`) reviewer model is forwarded verbatim.

#### Scenario: codex reviewer + auto omits the model flag

- **WHEN** the effective reviewer command is `codex` and `models.review` (or `review_harness.model`) is `"auto"`
- **THEN** the reviewer model handed to the codex invocation SHALL be omitted (no `-m` flag)
- **AND** the value `claude-fable-5` SHALL NOT be passed to codex

#### Scenario: claude reviewer + auto still resolves the fable id

- **WHEN** the effective reviewer command is `claude` and `models.review` (or `review_harness.model`) is `"auto"`
- **THEN** the reviewer model handed to the claude invocation SHALL be `"claude-fable-5"` (round-aware, unchanged)

### Requirement: Config-load adversarial auto preference MAY be refined at runtime for Claude entitlement only

Config-load resolution for Adversarial `auto` SHALL continue to prefer the full id `claude-fable-5` for a Claude reviewer (see existing adversarial auto requirements). That preferred value is the **first** model requested at runtime. When the model source is `"auto"` and the Claude reviewer returns a deterministic Fable/usage-credit entitlement failure, the pipeline MAY request the allowlisted subscription-backed model `sonnet` on a single subsequent attempt as specified by `review-auto-entitlement-fallback`. Config-load resolution SHALL NOT rewrite the preferred auto value to `sonnet` solely because the host account may lack Fable credits. Explicit non-`auto` model strings SHALL remain unchanged at both config-load and runtime.

#### Scenario: Config-load still prefers fable under auto

- **WHEN** `models.review` is `"auto"` and the effective reviewer is `claude`
- **THEN** the config-load resolved review model SHALL be `"claude-fable-5"`
- **AND** the first Claude reviewer invoke for an adversarial stage SHALL request that preferred model before any entitlement fallback

#### Scenario: Runtime entitlement fallback does not mutate resolved config preference

- **WHEN** an auto-sourced Claude reviewer falls back once to `sonnet` after a Fable entitlement failure
- **THEN** the config-load resolved `models.review` preference for auto SHALL remain `"claude-fable-5"` for subsequent stages that re-resolve from config
- **AND** only the failed attempt’s in-process retry SHALL use `sonnet`

#### Scenario: Explicit model string is not auto-fallback eligible at routing layer

- **WHEN** `models.review` is the explicit string `"claude-fable-5"`
- **THEN** routing SHALL treat the model as non-auto
- **AND** no entitlement model rewrite SHALL be authorized by the auto routing layer

