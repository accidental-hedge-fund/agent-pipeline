## ADDED Requirements

### Requirement: Config SHALL accept an optional `ci_mode` key selecting the pre-merge CI verification source

`PartialConfigSchema` SHALL accept an optional `ci_mode` key validated as an enum with exactly the values `github` and `local`. `PipelineConfig.ci_mode` SHALL be a required (non-optional) field on the resolved config — it SHALL never be `undefined` at runtime — and `DEFAULT_CONFIG.ci_mode` SHALL be `"github"`. An absent key SHALL resolve to `"github"`, preserving the current behavior in which the pre-merge gate waits on `gh pr checks`. A value outside the enum SHALL cause `resolveConfig()` to throw a parse error identifying `ci_mode` as the offending field, consistent with the strict-validation contract used for the other config fields. The `ci_mode` key SHALL carry a `.describe()` annotation so the JSON Schema emitted by `pipeline config schema` includes a non-empty `description` and the `github`/`local` enum for `ci_mode`.

#### Scenario: ci_mode absent — defaults to github

- **WHEN** `.github/pipeline.yml` does not include a `ci_mode` key
- **THEN** `resolveConfig()` SHALL return a config with `ci_mode === "github"`
- **AND** the pre-merge gate behavior SHALL be unchanged from prior behavior (waits on `gh pr checks`)

#### Scenario: ci_mode local accepted

- **WHEN** `.github/pipeline.yml` sets `ci_mode: local`
- **THEN** `resolveConfig()` SHALL succeed and the resolved config SHALL carry `ci_mode === "local"`

#### Scenario: out-of-enum ci_mode rejected

- **WHEN** `.github/pipeline.yml` sets `ci_mode: skip` (a value other than `github` or `local`)
- **THEN** `resolveConfig()` SHALL throw a parse error identifying `ci_mode` as the offending field

#### Scenario: emitted JSON Schema exposes the ci_mode enum

- **WHEN** the user runs `pipeline config schema`
- **THEN** the emitted JSON Schema SHALL include a `ci_mode` property whose allowed values are exactly `github` and `local`
- **AND** the `ci_mode` property SHALL carry a non-empty `description`
