## ADDED Requirements

### Requirement: harness_sandbox key accepted in pipeline.yml
`PartialConfigSchema` SHALL accept an optional boolean key `harness_sandbox`. The resolved `PipelineConfig` SHALL include `harness_sandbox: boolean`; `DEFAULT_CONFIG` SHALL set it to `false`. An absent key SHALL resolve to `false`, preserving the current behaviour.

#### Scenario: harness_sandbox true accepted
- **WHEN** `.github/pipeline.yml` sets `harness_sandbox: true`
- **THEN** `resolveConfig()` SHALL return a config with `harness_sandbox === true` without throwing

#### Scenario: harness_sandbox absent defaults to false
- **WHEN** `.github/pipeline.yml` does not include a `harness_sandbox` key
- **THEN** `resolveConfig()` SHALL return a config with `harness_sandbox === false`

#### Scenario: harness_sandbox with invalid type rejected
- **WHEN** `.github/pipeline.yml` sets `harness_sandbox: "yes"` (non-boolean)
- **THEN** `resolveConfig()` SHALL throw an error identifying `harness_sandbox` as the offending field
