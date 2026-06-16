## ADDED Requirements

### Requirement: Config SHALL accept an optional shipcheck_gate block
`PartialConfigSchema` SHALL accept an optional `shipcheck_gate` key. When absent, `shipcheck_gate.enabled` SHALL default to `false` and all other fields SHALL take their defaults. When present, the block SHALL validate against a sub-schema with the following optional fields:

- `enabled` (`boolean`, default `false`): when `true`, the `shipcheck-gate` stage runs the reviewer-harness acceptance rubric.
- `mode` (`"advisory" | "gate"`, default `"advisory"`): `advisory` records findings without blocking; `gate` blocks `ready-to-deploy` on a `fail` verdict.
- `max_rounds` (`integer ≥ 1`, default `1`): maximum reviewer invocations before surfacing a parse-failure outcome.
- `rubric_path` (`string`, default `".github/shipcheck-rubric.md"`): repo-root-relative path to the private Markdown rubric file.
- `block_on_partial` (`boolean`, default `false`): when `true` and `mode` is `"gate"`, a `partial` verdict also blocks `ready-to-deploy`.

An unknown key under `shipcheck_gate:` SHALL be rejected by strict schema validation, consistent with the rest of `PartialConfigSchema`.

#### Scenario: shipcheck_gate block accepted with valid keys
- **WHEN** `.github/pipeline.yml` sets `shipcheck_gate.enabled: true` and `shipcheck_gate.mode: gate`
- **THEN** `cfg.shipcheck_gate.enabled` SHALL be `true`
- **AND** `cfg.shipcheck_gate.mode` SHALL be `"gate"`
- **AND** `cfg.shipcheck_gate.max_rounds` SHALL default to `1`
- **AND** `cfg.shipcheck_gate.rubric_path` SHALL default to `".github/shipcheck-rubric.md"`
- **AND** `cfg.shipcheck_gate.block_on_partial` SHALL default to `false`

#### Scenario: shipcheck_gate block absent — defaults applied
- **WHEN** `.github/pipeline.yml` has no `shipcheck_gate` block
- **THEN** `cfg.shipcheck_gate.enabled` SHALL be `false`
- **AND** the pipeline SHALL skip the `shipcheck-gate` stage

#### Scenario: unknown key under shipcheck_gate rejected
- **WHEN** `.github/pipeline.yml` adds an unrecognized key under `shipcheck_gate:`
- **THEN** `resolveConfig()` SHALL throw with a parse error identifying the offending key
