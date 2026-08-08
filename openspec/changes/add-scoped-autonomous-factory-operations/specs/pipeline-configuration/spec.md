## MODIFIED Requirements

### Requirement: Never-auto-merge safety floor is structural, not config-forced

Repository configuration SHALL NOT authorize merge. There is no merge stage, and the autonomous advance path stops at `pipeline:ready-to-deploy`. The `auto_merge` key SHALL be absent from `PartialConfigSchema`; a repository that sets it SHALL receive a strict-schema parse error that identifies the offending key. The existing loop-isolated `pipeline merge` and `pipeline merge-queue --apply` commands remain explicit authority surfaces. A disabled deployment wrapper MAY validate a scoped operator grant before it invokes a permitted command, but that grant SHALL be machine-local deployment state and SHALL NOT be loaded from `.github/pipeline.yml`.

#### Scenario: auto_merge key rejected

- **WHEN** `.github/pipeline.yml` sets `auto_merge: true`
- **THEN** `resolveConfig()` SHALL throw with a parse error that identifies `auto_merge` as an unknown key

#### Scenario: Factory authority cannot be set in repository config

- **WHEN** `.github/pipeline.yml` sets a grant, delegated merge, or factory-authority key
- **THEN** strict schema validation SHALL reject that key
- **AND** repository content SHALL NOT grant a supervisor mutation authority
