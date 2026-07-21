## MODIFIED Requirements

### Requirement: The `roadmap:` config block SHALL be accepted in `.github/pipeline.yml`

`PartialConfigSchema` in `config.ts` SHALL accept a `roadmap:` sub-key with fields: `include_labels` (string[], optional), `exclude_labels` (string[], optional), `score_weights` (object with optional numeric overrides for `impact`, `confidence`, `ease`, `risk_reduction`, `dep_leverage`), `hygiene_auto_apply` (boolean, default false), `pr_docs` (boolean, default true), `release_model` (`'semver' | 'continuous'`, optional, default `'semver'`). Unknown keys under `roadmap:` SHALL trigger a strict-schema parse error.

#### Scenario: Valid roadmap config is accepted

- **WHEN** `.github/pipeline.yml` contains `roadmap: { pr_docs: false, score_weights: { impact: 2 } }`
- **THEN** config parsing SHALL succeed and `config.roadmap.pr_docs` SHALL be false

#### Scenario: Valid `release_model` value is accepted

- **WHEN** `.github/pipeline.yml` contains `roadmap: { release_model: continuous }`
- **THEN** config parsing SHALL succeed and `config.roadmap.release_model` SHALL be `'continuous'`

#### Scenario: Invalid `release_model` value is rejected

- **WHEN** `.github/pipeline.yml` contains `roadmap: { release_model: train }`
- **THEN** config parsing SHALL throw a validation error naming `roadmap.release_model` and listing the allowed values `['semver', 'continuous']`

#### Scenario: Absent `release_model` defaults to semver

- **WHEN** `.github/pipeline.yml` contains a `roadmap:` block with no `release_model` key
- **THEN** `config.roadmap.release_model` SHALL equal `'semver'`

#### Scenario: Unknown roadmap config key is rejected

- **WHEN** `.github/pipeline.yml` contains `roadmap: { unknown_key: true }`
- **THEN** config parsing SHALL throw a strict-schema parse error identifying `unknown_key` as unrecognized
