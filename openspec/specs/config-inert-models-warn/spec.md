# config-inert-models-warn Specification

## Purpose
TBD - created by archiving change config-warn-inert-models-alias. Update Purpose after archive.
## Requirements
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

### Requirement: Warn when an effort.* value is set for a stage whose harness ignores per-stage effort

`resolveConfig()` SHALL emit a non-blocking `console.warn` for each `effort.*` key that is (a) explicitly present in the file config and (b) backing a stage whose harness ignores per-stage effort. Because both the claude harness (`--effort`) and the codex harness (`-c model_reasoning_effort`) honor per-stage effort, the only harness that ignores it is a **custom reviewer CLI** configured via `review_harness` (which honors neither a model nor an effort flag). The warning SHALL name the key, its value, the affected reviewer command, and the reason the setting is ignored. It SHALL NOT throw, mutate the resolved config, or trigger a fallback.

> Note (see the change's design.md): issue #366 phrased this as "warn for a codex stage", which rests on the false premise that codex ignores effort (it does not — `harness.ts` appends `-c model_reasoning_effort`). The honest inert case is a custom reviewer CLI. If the maintainer prefers no effort advisory at all, this requirement is additive and may be dropped without affecting the rest of the change.

#### Scenario: effort.review set with a custom reviewer CLI warns

- **WHEN** `.github/pipeline.yml` sets `review_harness: my-reviewer` and `effort: { review: high }`
- **THEN** `resolveConfig()` SHALL emit a `console.warn` naming `effort.review`, the value `high`, the reviewer command `my-reviewer`, and an indication that the setting is ignored

#### Scenario: effort.review set with a claude reviewer — no warning

- **WHEN** `.github/pipeline.yml` sets `effort: { review: high }` and the effective reviewer harness is `claude`
- **THEN** `resolveConfig()` SHALL NOT emit an inert-effort warning for `effort.review` (claude honors `--effort`)

#### Scenario: effort.implementing set with a codex implementer — no warning

- **WHEN** `.github/pipeline.yml` sets `effort: { implementing: low }` and the implementer harness is `codex`
- **THEN** `resolveConfig()` SHALL NOT emit an inert-effort warning for `effort.implementing` (codex honors `-c model_reasoning_effort`)

#### Scenario: effort key absent — no warning

- **WHEN** `.github/pipeline.yml` has no `effort:` block, even with a custom reviewer CLI configured
- **THEN** `resolveConfig()` SHALL NOT emit any inert-effort warning (default-unset keys never warn)

### Requirement: The inert-effort advisory SHALL be non-blocking and SHALL NOT alter resolved config

The inert-effort advisory SHALL be advisory only. `resolveConfig()` SHALL return the same `PipelineConfig` regardless of whether the advisory was emitted; the inert effort value SHALL remain in the resolved config for its stage. No exception SHALL be thrown.

#### Scenario: pipeline run continues after inert-effort warning

- **WHEN** an inert-effort warning is emitted during `resolveConfig()`
- **THEN** `resolveConfig()` SHALL complete normally and return a valid `PipelineConfig`, with the effort value preserved for its stage

### Requirement: Warn when a models.* alias is explicitly set but its backing harness ignores model aliases

`resolveConfig()` SHALL emit a `console.warn` for each `models.*` key that is (a) explicitly present in the file config (`fileConfig.models?.<key>` is not `undefined`) and (b) backed by a harness that ignores model aliases for that key. A harness ignores a model alias when:

- for an **implementer-role** key (`models.planning`, `models.implementing`, `models.fix`), the implementer harness is `codex` (implementer model passthrough is not implemented — those aliases remain inert); and
- for the **reviewer-role** key (`models.review`), the effective reviewer command is a **custom** reviewer CLI — i.e. neither `claude` nor `codex`. The reviewer role SHALL NOT warn when the reviewer command is `codex`, because the codex reviewer now honors the model via `codex exec -m <model>`, nor when it is `claude`.

The warning SHALL name the key, its value, the affected harness/reviewer, and the reason the setting is ignored. The warning SHALL NOT throw, mutate the resolved config, or trigger a fallback.

#### Scenario: models.review set with reviewer=codex — no warning

- **WHEN** `.github/pipeline.yml` sets `models.review` and the effective reviewer command is `codex`
- **THEN** `resolveConfig()` SHALL NOT emit an inert-alias warning for `models.review` (the codex reviewer honors `-m <model>`)

#### Scenario: models.review set with a custom reviewer CLI warns

- **WHEN** `.github/pipeline.yml` sets `review_harness: my-reviewer` and `models.review`
- **THEN** `resolveConfig()` SHALL emit a `console.warn` naming `models.review`, the configured value, the reviewer command `my-reviewer`, and an indication that the alias is ignored

#### Scenario: models.planning set with implementer=codex warns

- **WHEN** `.github/pipeline.yml` sets `models.planning` and the active profile has `harnesses.implementer === "codex"`
- **THEN** `resolveConfig()` SHALL emit a `console.warn` containing `models.planning`, the configured value, the word `codex`, and an indication that the alias is ignored

#### Scenario: models.fix set with implementer=codex warns

- **WHEN** `.github/pipeline.yml` sets `models.fix` and the active profile has `harnesses.implementer === "codex"`
- **THEN** `resolveConfig()` SHALL emit a `console.warn` containing `models.fix`, the configured value, the word `codex`, and an indication that the alias is ignored

