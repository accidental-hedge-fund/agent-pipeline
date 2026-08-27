## MODIFIED Requirements

### Requirement: Config discovered from the git-root .github/pipeline.yml
`resolveConfig()` SHALL walk up from the target path (or cwd) to the enclosing `.git` root and load `.github/pipeline.yml` if present. When the file is absent, execution-policy resolution SHALL fail closed as specified by `required-repository-harness-roles` rather than applying `DEFAULT_CONFIG` plus the active profile's harness pair. Setup and dependency-free introspection commands that are documented as exempt MAY proceed without the file.

#### Scenario: no config file
- **WHEN** the repo root has no `.github/pipeline.yml`
- **AND** configuration is resolved for execution
- **THEN** resolution SHALL fail with a diagnostic naming the missing file
- **AND** the resolved live implementer and reviewer SHALL NOT equal the active profile's roles

#### Scenario: config resolved from a nested working directory
- **WHEN** the pipeline is invoked from a subdirectory of the repo
- **THEN** `resolveConfig()` SHALL still locate and load the root `.github/pipeline.yml`

### Requirement: Harness roles SHALL come from repository config when declared, otherwise the active profile

Live `harnesses` (`implementer`/`reviewer`) roles SHALL come from the repository's strict `harnesses:` block in `.github/pipeline.yml`. Execution-policy resolution SHALL require both keys. `PartialConfigSchema` SHALL accept the `harnesses` block with exactly the keys `implementer` and `reviewer`; any other key inside it SHALL be a strict-schema parse error. The optional `review_harness` key SHALL remain a structured overlay that MUST agree with `harnesses.reviewer` when both name a command (see `configurable-harness-roles` and `configurable-review-harness`). The active profile SHALL NOT supply a missing live role. See `required-repository-harness-roles` for the fail-closed gate and exemptions.

#### Scenario: harnesses block accepted and applied

- **WHEN** `.github/pipeline.yml` sets `harnesses:` with `implementer: grok` and `reviewer: codex`
- **THEN** `resolveConfig()` SHALL set `cfg.harnesses.implementer` to `"grok"` and `cfg.harnesses.reviewer` to `"codex"` regardless of the active profile

#### Scenario: unknown key inside harnesses rejected

- **WHEN** `.github/pipeline.yml` sets a `harnesses:` block containing a key other than `implementer` or `reviewer`
- **THEN** `resolveConfig()` SHALL throw with a parse error identifying that key

#### Scenario: absent block falls back to the profile

- **WHEN** `.github/pipeline.yml` sets no `harnesses:` block and no `review_harness` key
- **AND** configuration is resolved for execution
- **THEN** resolution SHALL fail closed
- **AND** `cfg.harnesses.implementer` and `cfg.harnesses.reviewer` SHALL NOT equal the active profile's roles

#### Scenario: implementer declared, reviewer omitted

- **WHEN** `.github/pipeline.yml` sets `harnesses:` with only `implementer: grok`
- **AND** configuration is resolved for execution
- **THEN** resolution SHALL fail closed
- **AND** `cfg.harnesses.reviewer` SHALL NOT equal the active profile's reviewer
