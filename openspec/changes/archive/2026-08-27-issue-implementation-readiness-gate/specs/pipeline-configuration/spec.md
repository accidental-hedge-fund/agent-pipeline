## ADDED Requirements

### Requirement: Config SHALL accept an optional issue_readiness block

`PartialConfigSchema` SHALL accept an optional `issue_readiness` key. When absent, `issue_readiness.enabled` SHALL default to `false` and `issue_readiness.timeout` SHALL default to `600`. When present, the block SHALL validate against a sub-schema with the following optional fields:

- `enabled` (`boolean`, default `false`): when `true`, the shared issue-implementation-readiness gate runs before pickup of a `pipeline:ready` issue.
- `timeout` (`integer ≥ 1`, default `600`): seconds allowed for the Implementer planning-treatment admission call.

An unknown key under `issue_readiness:` SHALL be rejected by strict schema validation, consistent with the rest of `PartialConfigSchema`. Both fields SHALL carry `.describe()` text so generated config docs include them. `issue_readiness.enabled` SHALL appear in `RIGOR_GATING_PATHS` because it changes paid-call volume.

#### Scenario: issue_readiness block accepted with enabled true

- **WHEN** `.github/pipeline.yml` sets `issue_readiness.enabled: true`
- **THEN** `cfg.issue_readiness.enabled` SHALL be `true`
- **AND** `cfg.issue_readiness.timeout` SHALL default to `600`

#### Scenario: issue_readiness block absent — defaults applied

- **WHEN** `.github/pipeline.yml` has no `issue_readiness` block
- **THEN** `cfg.issue_readiness.enabled` SHALL be `false`
- **AND** pickup behavior SHALL match the pre-change paths

#### Scenario: unknown key under issue_readiness rejected

- **WHEN** `.github/pipeline.yml` adds an unrecognized key under `issue_readiness:`
- **THEN** `resolveConfig()` SHALL throw with a parse error identifying the offending key

#### Scenario: non-boolean enabled rejected

- **WHEN** `.github/pipeline.yml` sets `issue_readiness.enabled: "yes"`
- **THEN** `resolveConfig()` SHALL throw identifying `issue_readiness.enabled`
