# config-inert-models-warn Specification

## Purpose
TBD - created by archiving change config-warn-inert-models-alias. Update Purpose after archive.
## Requirements
### Requirement: Warn when a models.* alias is explicitly set but the backing harness role is codex
`resolveConfig()` SHALL emit a `console.warn` for each `models.*` key that is (a) explicitly present in the file config (`fileConfig.models?.<key>` is not `undefined`) and (b) whose backing harness role is `codex`. The warning SHALL name the key, its value, the affected harness role, and the reason the setting is ignored. The warning SHALL NOT throw, mutate the resolved config, or trigger a fallback.

#### Scenario: models.review set with reviewer=codex warns
- **WHEN** `.github/pipeline.yml` sets `models.review` and the active profile has `harnesses.reviewer === "codex"`
- **THEN** `resolveConfig()` SHALL emit a `console.warn` containing `models.review`, the configured value, the word `codex`, and an indication that the alias is ignored

#### Scenario: models.planning set with implementer=codex warns
- **WHEN** `.github/pipeline.yml` sets `models.planning` and the active profile has `harnesses.implementer === "codex"`
- **THEN** `resolveConfig()` SHALL emit a `console.warn` containing `models.planning`, the configured value, the word `codex`, and an indication that the alias is ignored

#### Scenario: models.fix set with implementer=codex warns
- **WHEN** `.github/pipeline.yml` sets `models.fix` and the active profile has `harnesses.implementer === "codex"`
- **THEN** `resolveConfig()` SHALL emit a `console.warn` containing `models.fix`, the configured value, the word `codex`, and an indication that the alias is ignored

### Requirement: No warning when the backing harness role is claude
`resolveConfig()` SHALL NOT emit any warning for a `models.*` key when the backing harness role for that key is `claude`.

#### Scenario: models.review set with reviewer=claude — no warning
- **WHEN** `.github/pipeline.yml` sets `models.review` and the active profile has `harnesses.reviewer === "claude"`
- **THEN** `resolveConfig()` SHALL NOT emit any warning for `models.review`

#### Scenario: models.planning set with implementer=claude — no warning
- **WHEN** `.github/pipeline.yml` sets `models.planning` and the active profile has `harnesses.implementer === "claude"`
- **THEN** `resolveConfig()` SHALL NOT emit any warning for `models.planning`

### Requirement: No warning for default-valued models.* keys
`resolveConfig()` SHALL NOT emit a warning for any `models.*` key that was not explicitly set in the file config (i.e., the key is absent from `fileConfig.models` and takes its value from `DEFAULT_CONFIG`).

#### Scenario: models block absent from pipeline.yml — no warning
- **WHEN** `.github/pipeline.yml` has no `models:` block and the profile harness is `codex`
- **THEN** `resolveConfig()` SHALL NOT emit any warning

#### Scenario: models block present but specific key absent — no warning
- **WHEN** `.github/pipeline.yml` sets `models.review` but not `models.planning`, and the implementer harness is `codex`
- **THEN** `resolveConfig()` SHALL NOT emit a warning for `models.planning`

### Requirement: Warning is non-blocking and does not alter resolved config
The warning SHALL be advisory only. `resolveConfig()` SHALL return the same `PipelineConfig` regardless of whether a warning was emitted; the inert alias SHALL remain in `config.models.<key>` (it is not cleared or overridden). No exception SHALL be thrown.

#### Scenario: pipeline run continues after warning
- **WHEN** an inert-alias warning is emitted during `resolveConfig()`
- **THEN** the function SHALL complete normally and return a valid `PipelineConfig` with the original alias value preserved in `config.models.<key>`

