## MODIFIED Requirements

### Requirement: Never-auto-merge safety floor is structural, not config-forced
The pipeline SHALL never merge automatically: there is no merge stage and no merge command (see `pipeline-state-machine`). The `auto_merge` key SHALL be absent from `PartialConfigSchema`; a repo that sets it SHALL receive a strict-schema parse error identifying the offending key. The never-auto-merge guarantee is not config-governed — it is structural.

#### Scenario: auto_merge key rejected
- **WHEN** `.github/pipeline.yml` sets `auto_merge: true`
- **THEN** `resolveConfig()` SHALL throw with a parse error identifying `auto_merge` as an unknown key

### Requirement: Harness roles come from the active profile, not file config
The `harnesses` (`implementer`/`reviewer`) SHALL be taken from the active profile (`profile.harnesses`). The `harnesses` key SHALL be absent from `PartialConfigSchema`; a repo that sets it SHALL receive a strict-schema parse error. Repo config cannot influence harness role assignment.

#### Scenario: harnesses key rejected
- **WHEN** `.github/pipeline.yml` sets a `harnesses:` block
- **THEN** `resolveConfig()` SHALL throw with a parse error identifying `harnesses` as an unknown key
