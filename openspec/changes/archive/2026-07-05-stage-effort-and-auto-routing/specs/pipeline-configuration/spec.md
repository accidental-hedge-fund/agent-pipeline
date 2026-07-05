## ADDED Requirements

### Requirement: The config SHALL accept an optional effort block parallel to models

`PartialConfigSchema` SHALL accept an optional `effort:` block with the same per-stage key set as `models:` (`planning`, `implementing`, `review`, `fix`, `intake`, `sweep`). Each key SHALL be independently optional and SHALL accept either an arbitrary string or the literal `"auto"`. The block SHALL be strict: an unknown key under `effort:` SHALL be rejected at validation time. When a key is absent, `resolveConfig()` SHALL leave the resolved effort for that stage unset (no effort flag emitted).

#### Scenario: effort block accepted and resolved

- **WHEN** `.github/pipeline.yml` sets `effort: { planning: medium, implementing: low }`
- **THEN** `resolveConfig()` SHALL return a `PipelineConfig` whose resolved planning effort is `"medium"` and implementing effort is `"low"`

#### Scenario: unknown key under effort rejected

- **WHEN** `.github/pipeline.yml` sets `effort: { unknown_stage: low }`
- **THEN** `resolveConfig()` SHALL throw a parse error identifying `unknown_stage` as an unknown key under `effort`

#### Scenario: effort block absent — no effort flags

- **WHEN** `.github/pipeline.yml` has no `effort:` block
- **THEN** every stage's resolved effort SHALL be unset and no stage invocation SHALL emit an effort flag

### Requirement: models and effort keys SHALL accept the auto sentinel

`PartialConfigSchema` SHALL accept the literal string `"auto"` as a valid value for every `models.*` and `effort.*` key. A key set to `"auto"` SHALL pass strict schema validation (it is not treated as an unknown/invalid value). `resolveConfig()` SHALL resolve every `"auto"` value to a concrete string before returning; the returned `PipelineConfig` SHALL contain no `"auto"` value for any model or effort consulted by stage code.

#### Scenario: auto passes strict validation

- **WHEN** `.github/pipeline.yml` sets `models: { review: auto }` and `effort: { review: auto }`
- **THEN** `resolveConfig()` SHALL NOT throw and SHALL treat `auto` as a valid value

#### Scenario: auto fully resolved in returned config

- **WHEN** any `models.*` or `effort.*` key is `"auto"`
- **THEN** the returned `PipelineConfig` SHALL expose a concrete resolved value for that stage, never the literal `"auto"`

### Requirement: review_harness SHALL accept a structured command/model/effort form

`PartialConfigSchema` SHALL accept `review_harness` as either a bare string (the existing shorthand) or a strict object `{ command, model?, effort? }`, where `model` and `effort` each accept an arbitrary string or `"auto"`. When the object form is given, `resolveConfig()` SHALL set `cfg.harnesses.reviewer` from `command`, `cfg.harnesses.reviewerModel` from `model`, and `cfg.harnesses.reviewerEffort` from `effort`. When the string shorthand is given, `reviewerModel` and `reviewerEffort` SHALL remain unset so review routing falls back to `cfg.models.review` and `cfg.effort.review` unchanged.

#### Scenario: structured review_harness unpacked

- **WHEN** `.github/pipeline.yml` sets `review_harness: { command: claude, model: claude-fable-5, effort: high }`
- **THEN** `cfg.harnesses.reviewer` SHALL be `"claude"`, `cfg.harnesses.reviewerModel` SHALL be `"claude-fable-5"`, and `cfg.harnesses.reviewerEffort` SHALL be `"high"`

#### Scenario: string review_harness leaves model/effort unset

- **WHEN** `.github/pipeline.yml` sets `review_harness: claude`
- **THEN** `cfg.harnesses.reviewer` SHALL be `"claude"` and both `cfg.harnesses.reviewerModel` and `cfg.harnesses.reviewerEffort` SHALL be unset

#### Scenario: unknown key under structured review_harness rejected

- **WHEN** `.github/pipeline.yml` sets `review_harness: { command: claude, temperature: 0.2 }`
- **THEN** `resolveConfig()` SHALL throw a parse error identifying `temperature` as an unknown key under `review_harness`
