## MODIFIED Requirements

### Requirement: The models block SHALL accept an implementing slot

`PartialConfigSchema.models` SHALL accept an optional `implementing` key in addition to `planning`, `review`, and `fix`. `resolveConfig()` SHALL merge it using the same `fileConfig.models?.implementing ?? DEFAULT_CONFIG.models.implementing` pattern as the other slots. `DEFAULT_CONFIG.models.implementing` SHALL be `"sonnet"`, preserving existing behavior for all repos that do not set the key. An unknown key in the `models:` block SHALL still be rejected by `.strict()` schema validation.

#### Scenario: implementing slot accepted and resolved

- **WHEN** `.github/pipeline.yml` sets `models: { implementing: "opus" }`
- **THEN** `resolveConfig()` SHALL return a `PipelineConfig` with `models.implementing === "opus"`

#### Scenario: implementing slot absent — default applied

- **WHEN** `.github/pipeline.yml` omits the `implementing` key (or omits `models` entirely)
- **THEN** `resolveConfig()` SHALL return `models.implementing === "sonnet"` and all other behavior SHALL be identical to today

#### Scenario: unknown key under models still rejected

- **WHEN** `.github/pipeline.yml` sets `models: { unknown_slot: "opus" }`
- **THEN** `resolveConfig()` SHALL throw a parse error identifying `unknown_slot` as an unknown key under `models`

### Requirement: Both implementer invocations SHALL resolve the implementing slot

The implementing harness SHALL be invoked with `model: opts.model ?? cfg.models.implementing` at both call sites — the standard (non-OpenSpec) path and the OpenSpec path — matching the `opts.model ?? cfg.models.<slot>` pattern used for all other harness invocations. A bare `model: opts.model` at either site is a defect.

#### Scenario: standard implementing path uses the configured alias

- **WHEN** `.github/pipeline.yml` sets `models.implementing: "haiku"` and no CLI `--model` override is given
- **THEN** the standard implementing harness SHALL be invoked with the alias `"haiku"`

#### Scenario: OpenSpec implementing path uses the configured alias

- **WHEN** `.github/pipeline.yml` sets `models.implementing: "haiku"`, an OpenSpec change is active, and no CLI `--model` override is given
- **THEN** the OpenSpec implementing harness SHALL be invoked with the alias `"haiku"`

#### Scenario: CLI override wins over config

- **WHEN** `.github/pipeline.yml` sets `models.implementing: "haiku"` and `--model opus` is passed via CLI
- **THEN** the implementing harness SHALL be invoked with `"opus"` (CLI wins over config)
