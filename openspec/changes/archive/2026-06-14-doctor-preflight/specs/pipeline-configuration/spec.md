## ADDED Requirements

### Requirement: Config SHALL accept an optional `doctor` block controlling preflight behavior

`PartialConfigSchema` SHALL accept an optional `doctor` key. When present, it SHALL validate against a sub-schema with the following optional fields:

- `runOnStart` (`boolean`, default `false`): when `true`, the pipeline runs the preflight checks before the planning stage.
- `failFast` (`boolean`, default `false`): when `true`, doctor stops at the first failing check rather than collecting all failures.

An unknown key under `doctor:` SHALL be rejected by strict schema validation, consistent with the rest of `PartialConfigSchema`.

#### Scenario: doctor block accepted with valid keys

- **WHEN** `.github/pipeline.yml` sets `doctor: { runOnStart: true, failFast: false }`
- **THEN** `resolveConfig()` SHALL accept it and expose `config.doctor.runOnStart === true` and `config.doctor.failFast === false`

#### Scenario: doctor block absent — defaults applied

- **WHEN** `.github/pipeline.yml` does not include a `doctor:` key
- **THEN** the resolved config SHALL have `doctor.runOnStart === false` and `doctor.failFast === false`

#### Scenario: unknown key under doctor rejected

- **WHEN** `.github/pipeline.yml` sets `doctor: { autoFix: true }`
- **THEN** `resolveConfig()` SHALL throw a parse error identifying `autoFix` as an unknown key under `doctor`
