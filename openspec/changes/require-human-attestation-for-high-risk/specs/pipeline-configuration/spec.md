## ADDED Requirements

### Requirement: Config SHALL accept an optional strict pre_code_attestation block

`PartialConfigSchema` SHALL accept an optional `pre_code_attestation` key. When present, it SHALL
validate against the strict sub-schema defined by the `pre-code-attestation` capability (enablement,
triggers, extra_triggers, thresholds, expiration, approvers, separation_of_duties, wait). Unknown
keys under `pre_code_attestation` SHALL be rejected. When the key is absent, the resolved config
SHALL disable the pre-code attestation gate and preserve current autonomous advancement behavior
for planning into implementation.

#### Scenario: valid pre_code_attestation block accepted

- **WHEN** `.github/pipeline.yml` sets a valid `pre_code_attestation` object with `enabled: true` and known fields only
- **THEN** `resolveConfig()` SHALL accept it
- **AND** expose the parsed fields on the resolved config

#### Scenario: omitted block disables gate

- **WHEN** `.github/pipeline.yml` omits `pre_code_attestation`
- **THEN** `resolveConfig()` SHALL set the gate enabled flag to `false`
- **AND** SHALL NOT require human attestation for implementation advancement solely due to this omission

#### Scenario: unknown nested key rejected

- **WHEN** `.github/pipeline.yml` sets `pre_code_attestation: { enabled: true, auto_approve: true }`
- **THEN** `resolveConfig()` SHALL throw a parse error identifying `auto_approve`

#### Scenario: documentation surfaces examples

- **WHEN** generated or hand-maintained config reference docs for pipeline.yml are produced after this change
- **THEN** they SHALL document the `pre_code_attestation` block with field descriptions and at least one example
)
