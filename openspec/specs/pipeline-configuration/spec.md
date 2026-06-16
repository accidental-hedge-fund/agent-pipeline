# pipeline-configuration Specification

## Purpose
How a repo configures the pipeline through `.github/pipeline.yml`: discovery from the git root, YAML parsing and strict schema validation, the precedence of CLI overrides over file config over `DEFAULT_CONFIG`, and the safety floor (the never-auto-merge guarantee is structural; harness roles come from the profile, not file config). Per-feature config blocks (`test_gate`, `eval_gate`, `openspec`, `last30days`) are refined by their own delta specs; this baseline covers loading, validation, and precedence.
## Requirements
### Requirement: Config discovered from the git-root .github/pipeline.yml
`resolveConfig()` SHALL walk up from the target path (or cwd) to the enclosing `.git` root and load `.github/pipeline.yml` if present. When the file is absent, every non-identity field SHALL take its `DEFAULT_CONFIG` value.

#### Scenario: no config file
- **WHEN** the repo root has no `.github/pipeline.yml`
- **THEN** the resolved config SHALL equal `DEFAULT_CONFIG` for all behavioral fields

#### Scenario: config resolved from a nested working directory
- **WHEN** the pipeline is invoked from a subdirectory of the repo
- **THEN** `resolveConfig()` SHALL still locate and load the root `.github/pipeline.yml`

### Requirement: YAML parsed and validated against a schema; invalid config fails fast
The file SHALL be parsed as YAML and validated against a zod schema. An invalid value (wrong type, failed constraint, or an unknown key in a strict block) SHALL cause `resolveConfig()` to throw with parse details rather than silently using a wrong value.

#### Scenario: malformed value rejected
- **WHEN** `.github/pipeline.yml` sets `max_concurrent_worktrees` to a non-numeric value
- **THEN** `resolveConfig()` SHALL throw an error identifying the offending field

### Requirement: Precedence is CLI over file over defaults
For each field, an explicit CLI override (e.g. `--base`) SHALL win over the file value, which SHALL win over `DEFAULT_CONFIG`. Merging is field-by-field; unspecified fields keep their default.

#### Scenario: file override
- **WHEN** the file sets `base_branch: staging` and no CLI override is given
- **THEN** the resolved `base_branch` SHALL be `staging` and all other fields keep their defaults

#### Scenario: CLI wins over file
- **WHEN** the file sets `base_branch: staging` and `--base develop` is passed
- **THEN** the resolved `base_branch` SHALL be `develop`

### Requirement: Never-auto-merge safety floor is structural, not config-forced
The pipeline SHALL never merge automatically: there is no merge stage and no merge command (see `pipeline-state-machine`). The `auto_merge` key SHALL be absent from `PartialConfigSchema`; a repo that sets it SHALL receive a strict-schema parse error identifying the offending key. The never-auto-merge guarantee is not config-governed — it is structural.

#### Scenario: auto_merge key rejected
- **WHEN** `.github/pipeline.yml` sets `auto_merge: true`
- **THEN** `resolveConfig()` SHALL throw with a parse error identifying `auto_merge` as an unknown key

### Requirement: Harness roles come from the active profile, not file config
The `harnesses` (`implementer`/`reviewer`) SHALL be taken from the active profile (`profile.harnesses`). The `harnesses` key SHALL be absent from `PartialConfigSchema`; a repo that sets it SHALL receive a strict-schema parse error. The implementer harness SHALL NOT be overridable by file config. The reviewer harness MAY be overridden by the optional `review_harness` key (see `configurable-review-harness`); when `review_harness` is absent, the profile's reviewer is used unchanged.

#### Scenario: harnesses key rejected
- **WHEN** `.github/pipeline.yml` sets a `harnesses:` block
- **THEN** `resolveConfig()` SHALL throw with a parse error identifying `harnesses` as an unknown key

#### Scenario: reviewer overridden via review_harness
- **WHEN** `.github/pipeline.yml` sets `review_harness: my-reviewer`
- **THEN** `cfg.harnesses.reviewer` SHALL be `"my-reviewer"` and `cfg.harnesses.implementer` SHALL remain as the profile's default implementer

#### Scenario: implementer cannot be overridden by file config
- **WHEN** `.github/pipeline.yml` sets only `review_harness`
- **THEN** `cfg.harnesses.implementer` SHALL equal the profile's implementer, unchanged by any file config key

### Requirement: Protected steps cannot be disabled via config
The `steps:` block SHALL accept only the four toggleable keys (`plan_review`, `standard_review`, `adversarial_review`, `docs`); any other key (e.g. an attempt to disable a structural step) SHALL be rejected at validation time.

#### Scenario: unknown step key rejected
- **WHEN** `.github/pipeline.yml` adds an unrecognized key under `steps:`
- **THEN** validation SHALL fail and `resolveConfig()` SHALL throw

### Requirement: Inert models.* aliases produce a diagnostic warning at config-resolve time
`resolveConfig()` SHALL detect and warn about `models.*` aliases that are explicitly set in `.github/pipeline.yml` but will be silently ignored because the backing harness role is `codex`. This requirement augments the existing config-loading contract without changing validation, precedence, or the never-auto-merge safety floor. See the `config-inert-models-warn` capability for full requirements and scenarios.

#### Scenario: explicit inert alias detected and warned
- **WHEN** `.github/pipeline.yml` explicitly sets one or more `models.*` keys and the backing harness role for each is `codex`
- **THEN** `resolveConfig()` SHALL emit a non-blocking `console.warn` for each affected key before returning the resolved config

### Requirement: Config SHALL accept an optional `doctor` block controlling preflight behavior

`PartialConfigSchema` SHALL accept an optional `doctor` key. When present, it SHALL validate against a sub-schema with the following optional fields:

- `runOnStart` (`boolean`, default `false`): when `true`, the pipeline runs the preflight checks before the planning stage.
- `failFast` (`boolean`, default `false`): when `true`, doctor stops at the first failing check rather than collecting all failures.

An unknown key under `doctor:` SHALL be rejected by strict schema validation, consistent with the rest of `PartialConfigSchema`.

#### Scenario: doctor block accepted with valid keys

- **WHEN** `.github/pipeline.yml` sets `doctor: { runOnStart: true, failFast: false }`
- **THEN** `resolveConfig()` SHALL accept it and expose `config.doctor.runOnStart === true` and `config.doctor.failFast === false`

#### Scenario: doctor block absent — defaults applied

- **WHEN** `.github/pipeline.yml` does not include a `doctor:` key
- **THEN** the resolved config SHALL have `doctor.runOnStart === false` and `doctor.failFast === false`

#### Scenario: unknown key under doctor rejected

- **WHEN** `.github/pipeline.yml` sets `doctor: { autoFix: true }`
- **THEN** `resolveConfig()` SHALL throw a parse error identifying `autoFix` as an unknown key under `doctor`

### Requirement: Config SHALL accept an optional `format_gate` array

`PartialConfigSchema` SHALL accept an optional `format_gate` key. When present, it SHALL validate as an array of objects, each with the following fields:

- `command` (`string`, required): the shell command to run in the worktree root (e.g. `"cargo fmt"`, `"eslint --fix src/"`).
- `auto_fix` (`boolean`, required): when `true`, the command is expected to mutate files; the pipeline commits any changes and re-runs the command to verify stability. When `false`, the command is check-only; a non-zero exit immediately blocks.

An unknown key under a `format_gate` entry SHALL be rejected by strict schema validation. When `format_gate` is absent or an empty array, behavior is unchanged.

#### Scenario: format_gate accepted with valid entries

- **WHEN** `.github/pipeline.yml` sets:
  ```yaml
  format_gate:
    - command: cargo fmt
      auto_fix: true
    - command: cargo clippy -D warnings
      auto_fix: false
  ```
- **THEN** `resolveConfig()` SHALL accept it and expose `config.format_gate` as an array of two entries

#### Scenario: format_gate absent — default is empty array

- **WHEN** `.github/pipeline.yml` does not include a `format_gate:` key
- **THEN** the resolved config SHALL have `config.format_gate` equal to `[]`
- **AND** no format gate commands SHALL be run

#### Scenario: format_gate entry missing required field rejected

- **WHEN** `.github/pipeline.yml` sets a `format_gate` entry without the `auto_fix` field
- **THEN** `resolveConfig()` SHALL throw a parse error identifying the missing field

#### Scenario: unknown key in format_gate entry rejected

- **WHEN** `.github/pipeline.yml` sets a `format_gate` entry with an unrecognized key (e.g. `working_dir`)
- **THEN** `resolveConfig()` SHALL throw a parse error identifying the unknown key
### Requirement: harness_sandbox key accepted in pipeline.yml
`PartialConfigSchema` SHALL accept an optional boolean key `harness_sandbox`. The resolved `PipelineConfig` SHALL include `harness_sandbox: boolean`; `DEFAULT_CONFIG` SHALL set it to `false`. An absent key SHALL resolve to `false`, preserving the current behaviour.

#### Scenario: harness_sandbox true accepted
- **WHEN** `.github/pipeline.yml` sets `harness_sandbox: true`
- **THEN** `resolveConfig()` SHALL return a config with `harness_sandbox === true` without throwing

#### Scenario: harness_sandbox absent defaults to false
- **WHEN** `.github/pipeline.yml` does not include a `harness_sandbox` key
- **THEN** `resolveConfig()` SHALL return a config with `harness_sandbox === false`

#### Scenario: harness_sandbox with invalid type rejected
- **WHEN** `.github/pipeline.yml` sets `harness_sandbox: "yes"` (non-boolean)
- **THEN** `resolveConfig()` SHALL throw an error identifying `harness_sandbox` as the offending field

