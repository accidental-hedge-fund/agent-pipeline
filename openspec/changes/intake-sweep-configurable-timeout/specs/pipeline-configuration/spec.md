## ADDED Requirements

### Requirement: The config schema SHALL accept `intake_timeout` and `sweep_timeout` keys

`PartialConfigSchema` SHALL include two new optional positive-integer keys:
`intake_timeout` (seconds for the intake harness call before timing out) and
`sweep_timeout` (seconds for the sweep harness call before timing out). Both SHALL
be validated as positive integers at parse time; a non-integer or non-positive value
SHALL cause `resolveConfig()` to throw with a parse error identifying the offending
field. When absent, both SHALL default to 600 seconds via `DEFAULT_CONFIG`.

#### Scenario: Both keys absent — defaults applied

- **WHEN** `.github/pipeline.yml` does not set `intake_timeout` or `sweep_timeout`
- **THEN** `cfg.intake_timeout` SHALL equal 600
- **AND** `cfg.sweep_timeout` SHALL equal 600

#### Scenario: File sets `intake_timeout`

- **WHEN** `.github/pipeline.yml` sets `intake_timeout: 300`
- **THEN** `cfg.intake_timeout` SHALL equal 300
- **AND** `cfg.sweep_timeout` SHALL still equal 600 (the default)

#### Scenario: Non-positive value rejected

- **WHEN** `.github/pipeline.yml` sets `intake_timeout: 0`
- **THEN** `resolveConfig()` SHALL throw a parse error identifying `intake_timeout` as the offending field

#### Scenario: Non-integer value rejected

- **WHEN** `.github/pipeline.yml` sets `sweep_timeout: "fast"`
- **THEN** `resolveConfig()` SHALL throw a parse error identifying `sweep_timeout` as the offending field
