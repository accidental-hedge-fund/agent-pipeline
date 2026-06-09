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
The `auto_merge` key SHALL be accepted in config for back-compat, but the pipeline SHALL never read or act on it: there is no merge stage and no merge command (see `pipeline-state-machine`). A repo cannot enable auto-merge through config because nothing consumes the value.

#### Scenario: auto_merge true is inert
- **WHEN** `.github/pipeline.yml` sets `auto_merge: true`
- **THEN** the value SHALL have no effect — the pipeline still stops at `ready-to-deploy`

### Requirement: Harness roles come from the active profile, not file config
The `harnesses` (`implementer`/`reviewer`) SHALL be taken from the active profile (`profile.harnesses`). A `harnesses` block in `.github/pipeline.yml` is accepted for back-compat but ignored, so repo config cannot invert a host-invoked run.

#### Scenario: file harnesses ignored
- **WHEN** the run uses the `claude` profile and the file sets `harnesses: { implementer: codex, reviewer: claude }`
- **THEN** the resolved `harnesses` SHALL remain `{ implementer: "claude", reviewer: "codex" }` from the profile

### Requirement: Protected steps cannot be disabled via config
The `steps:` block SHALL accept only the four toggleable keys (`plan_review`, `standard_review`, `adversarial_review`, `docs`); any other key (e.g. an attempt to disable a structural step) SHALL be rejected at validation time.

#### Scenario: unknown step key rejected
- **WHEN** `.github/pipeline.yml` adds an unrecognized key under `steps:`
- **THEN** validation SHALL fail and `resolveConfig()` SHALL throw
