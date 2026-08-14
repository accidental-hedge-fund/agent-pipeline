## ADDED Requirements

### Requirement: Config SHALL accept an optional strict override_governance block

`PartialConfigSchema` (or the equivalent strict config schema) SHALL accept an optional `override_governance` key. When present, it SHALL validate against the strict sub-schema defined by the `governed-overrides` capability: schema version, class taxonomy, per-class max duration, approver rules, required evidence, separation of duties, renewal mode, optional default class, and related closed enums. Unknown keys under `override_governance` SHALL be rejected at parse time. When the key is absent, resolved config SHALL enable the documented implicit low-risk compatibility class behavior rather than disabling all overrides.

#### Scenario: valid override_governance block accepted

- **WHEN** `.github/pipeline.yml` sets a valid `override_governance` object with known fields only and at least one class policy
- **THEN** `resolveConfig()` SHALL accept it
- **AND** expose the parsed class taxonomy and policies on the resolved config

#### Scenario: omitted block enables compatibility defaults

- **WHEN** `.github/pipeline.yml` omits `override_governance`
- **THEN** `resolveConfig()` SHALL succeed
- **AND** override recording SHALL remain available under the implicit low-risk compatibility class

#### Scenario: unknown nested key rejected

- **WHEN** `.github/pipeline.yml` sets `override_governance: { schema_version: 1, silent_approve: true }`
- **THEN** `resolveConfig()` SHALL throw a parse error identifying `silent_approve`
- **AND** the pipeline SHALL NOT run with that config

#### Scenario: documentation surfaces examples

- **WHEN** generated or hand-maintained config reference docs for pipeline.yml are produced after this change
- **THEN** they SHALL document the `override_governance` block with field descriptions and at least one example including a low-risk and a high-risk class
