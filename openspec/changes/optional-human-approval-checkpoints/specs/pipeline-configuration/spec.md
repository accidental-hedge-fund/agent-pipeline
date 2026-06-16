## ADDED Requirements

### Requirement: Config SHALL accept an optional `approval_checkpoints` array
`PartialConfigSchema` SHALL accept an optional `approval_checkpoints` key whose value is an array of stage-name strings. Each entry SHALL be validated against the `STAGES` constant: entries that are not in `STAGES`, or that equal `"backlog"` or `"ready-to-deploy"`, SHALL be rejected with a descriptive parse error at config-load time. When absent, the field SHALL default to `[]` (empty array), preserving fully-autonomous behavior.

#### Scenario: approval_checkpoints absent — defaults to empty
- **WHEN** `.github/pipeline.yml` does not include `approval_checkpoints`
- **THEN** `resolveConfig()` SHALL succeed
- **AND** `config.approvalCheckpoints` SHALL equal `[]`

#### Scenario: approval_checkpoints with valid stage names accepted
- **WHEN** `.github/pipeline.yml` sets `approval_checkpoints: ["implementing", "pre-merge"]`
- **THEN** `resolveConfig()` SHALL succeed
- **AND** `config.approvalCheckpoints` SHALL equal `["implementing", "pre-merge"]`

#### Scenario: unknown stage name rejected at config load
- **WHEN** `.github/pipeline.yml` sets `approval_checkpoints: ["deploy"]`
- **AND** `"deploy"` is not a member of `STAGES`
- **THEN** `resolveConfig()` SHALL throw with a parse error identifying the invalid stage name

#### Scenario: terminal stage `ready-to-deploy` rejected
- **WHEN** `.github/pipeline.yml` sets `approval_checkpoints: ["ready-to-deploy"]`
- **THEN** `resolveConfig()` SHALL throw with a parse error identifying `"ready-to-deploy"` as not a valid checkpoint stage

#### Scenario: initial triage stage `backlog` rejected
- **WHEN** `.github/pipeline.yml` sets `approval_checkpoints: ["backlog"]`
- **THEN** `resolveConfig()` SHALL throw with a parse error identifying `"backlog"` as not a valid checkpoint stage
