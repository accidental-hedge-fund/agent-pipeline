## ADDED Requirements

### Requirement: Repository config MAY extend trusted-surface path coverage but MUST NOT shrink built-in classes

`PartialConfigSchema` / `.github/pipeline.yml` MAY accept an optional `trusted_surface` block (exact key names fixed at implementation within schema tests) that only **adds** repository-local path globs or roots to existing path classes for classification. The block SHALL be validated by the strict config schema: unknown keys rejected; types enforced. Repository configuration SHALL NOT provide keys that disable, delete, rename, or replace built-in verifier-sensitive path classes, SHALL NOT set “use candidate as trusted,” and SHALL NOT authorize judging the candidate solely under candidate-authored weakened verifier material. Absence of the block SHALL leave built-in engine path classes unchanged and SHALL preserve `passthrough` behavior for candidates that touch no sensitive paths.

#### Scenario: additive extra_paths accepted

- **WHEN** `.github/pipeline.yml` sets a valid `trusted_surface` additive path entry for an existing class (for example extra globs under `eval_rubrics`)
- **THEN** `resolveConfig()` SHALL accept the config
- **AND** path classification SHALL treat matching candidate paths as members of that class in addition to built-in rules

#### Scenario: disable or shrink keys rejected

- **WHEN** `.github/pipeline.yml` sets a key that disables or removes a built-in trusted-surface class (for example `disable_classes` or `classes: []` replacement)
- **THEN** `resolveConfig()` SHALL throw a schema validation error identifying the offending key
- **AND** the engine SHALL continue to enforce built-in classes for runs that load default or valid config

#### Scenario: use-candidate-as-trusted rejected

- **WHEN** `.github/pipeline.yml` sets a key that requests the candidate tree as the trusted verifier source for sensitive classes
- **THEN** validation SHALL reject that key
- **AND** trusted-surface resolution SHALL remain bound to installed engine and base_ref authorities defined by the engine

#### Scenario: omitted block keeps baseline behavior

- **WHEN** a repository has no `trusted_surface` config block
- **AND** a candidate touches no built-in sensitive paths
- **THEN** trusted-surface outcome SHALL be `passthrough`
- **AND** config loading SHALL not require the new block
