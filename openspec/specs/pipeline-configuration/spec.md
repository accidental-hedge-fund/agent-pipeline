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

### Requirement: Config SHALL accept an optional shipcheck_gate block
`PartialConfigSchema` SHALL accept an optional `shipcheck_gate` key. When absent, `shipcheck_gate.enabled` SHALL default to `false` and all other fields SHALL take their defaults. When present, the block SHALL validate against a sub-schema with the following optional fields:

- `enabled` (`boolean`, default `false`): when `true`, the `shipcheck-gate` stage runs the reviewer-harness acceptance rubric.
- `mode` (`"advisory" | "gate"`, default `"advisory"`): `advisory` records findings without blocking; `gate` blocks `ready-to-deploy` on a `fail` verdict.
- `max_rounds` (`integer ≥ 1`, default `1`): maximum reviewer invocations before surfacing a parse-failure outcome.
- `rubric_path` (`string`, default `".github/shipcheck-rubric.md"`): repo-root-relative path to the private Markdown rubric file.
- `block_on_partial` (`boolean`, default `false`): when `true` and `mode` is `"gate"`, a `partial` verdict also blocks `ready-to-deploy`.

An unknown key under `shipcheck_gate:` SHALL be rejected by strict schema validation, consistent with the rest of `PartialConfigSchema`.

#### Scenario: shipcheck_gate block accepted with valid keys
- **WHEN** `.github/pipeline.yml` sets `shipcheck_gate.enabled: true` and `shipcheck_gate.mode: gate`
- **THEN** `cfg.shipcheck_gate.enabled` SHALL be `true`
- **AND** `cfg.shipcheck_gate.mode` SHALL be `"gate"`
- **AND** `cfg.shipcheck_gate.max_rounds` SHALL default to `1`
- **AND** `cfg.shipcheck_gate.rubric_path` SHALL default to `".github/shipcheck-rubric.md"`
- **AND** `cfg.shipcheck_gate.block_on_partial` SHALL default to `false`

#### Scenario: shipcheck_gate block absent — defaults applied
- **WHEN** `.github/pipeline.yml` has no `shipcheck_gate` block
- **THEN** `cfg.shipcheck_gate.enabled` SHALL be `false`
- **AND** the pipeline SHALL skip the `shipcheck-gate` stage

#### Scenario: unknown key under shipcheck_gate rejected
- **WHEN** `.github/pipeline.yml` adds an unrecognized key under `shipcheck_gate:`
- **THEN** `resolveConfig()` SHALL throw with a parse error identifying the offending key

### Requirement: PartialConfigSchema fields carry descriptions for JSON Schema generation

Each field in `PartialConfigSchema` SHALL be annotated with a `.describe("<text>")` call so that the JSON Schema generated by `pipeline config schema` includes a human-readable `description` for each property. Descriptions SHALL be suitable for editor tooltip display (concise, no more than one sentence per field).

#### Scenario: descriptions present after annotation

- **WHEN** `zod-to-json-schema` is applied to `PartialConfigSchema`
- **THEN** the resulting JSON Schema SHALL carry a non-empty `description` string on each top-level property
- **AND** sub-properties of `review_policy`, `steps`, `eval_gate`, and `shipcheck_gate` SHALL also carry descriptions

### Requirement: A hardcoded rigor-gating path list is maintained in config.ts

`config.ts` SHALL export a constant `RIGOR_GATING_PATHS: readonly string[]` enumerating the dotted paths of fields whose misconfiguration changes review coverage or paid-call volume. The initial list SHALL include at minimum: `review_policy.block_threshold`, `review_policy.min_confidence`, `review_policy.max_adversarial_rounds`, `steps.plan_review`, `steps.standard_review`, `steps.adversarial_review`, `eval_gate.enabled`, `eval_gate.mode`, `shipcheck_gate.enabled`, `shipcheck_gate.mode`. A test SHALL assert that every path in `RIGOR_GATING_PATHS` resolves to a real property in the JSON Schema emitted by `pipeline config schema`, so a rename or deletion in `PartialConfigSchema` fails CI rather than silently orphaning a gating path.

#### Scenario: rigor-gating paths are validated against the live schema

- **WHEN** the test suite runs
- **THEN** every entry in `RIGOR_GATING_PATHS` SHALL resolve to an existing property in the JSON Schema generated from `PartialConfigSchema`
- **AND** a path that does not exist in the schema SHALL cause the test to fail

#### Scenario: new rigor-gating field added to PartialConfigSchema

- **WHEN** a new field that affects review coverage or paid-call volume is added to `PartialConfigSchema`
- **THEN** the implementer SHALL add it to `RIGOR_GATING_PATHS` so the validate command classifies misconfigs of that field as severity `"error"` with `rigorGating: true`

### Requirement: Config SHALL accept an optional `review_policy.risk_proportional` flag

`review_policy` SHALL accept an optional boolean `risk_proportional` that gates
risk-proportional `review-2` blocking (see `review-risk-proportional-blocking`).
It SHALL default to `false`, under which `review-2` blocking is identical to
behavior before this capability. A non-boolean value SHALL be rejected at
config-parse time. The resolved flag SHALL be exposed on the effective config so
the review stage can read it. Because enabling it changes review coverage, the
dotted path `review_policy.risk_proportional` SHALL be present in
`RIGOR_GATING_PATHS` and SHALL resolve to a real property in the JSON Schema
emitted by `pipeline config schema`.

#### Scenario: Flag defaults to false

- **WHEN** a repo declares no `review_policy.risk_proportional`
- **THEN** the resolved config SHALL carry `risk_proportional: false` and `review-2` blocking SHALL be unchanged from prior behavior

#### Scenario: Flag accepted when declared

- **WHEN** a repo declares `review_policy.risk_proportional: true`
- **THEN** config resolution SHALL succeed and the effective config SHALL carry `risk_proportional: true`

#### Scenario: Non-boolean value rejected

- **WHEN** `review_policy.risk_proportional` is set to a non-boolean value
- **THEN** config resolution SHALL fail with a validation error

#### Scenario: Path is registered as rigor-gating

- **WHEN** the `RIGOR_GATING_PATHS`-to-schema coherence test runs
- **THEN** `review_policy.risk_proportional` SHALL be present in `RIGOR_GATING_PATHS` and SHALL resolve to a real property in the emitted JSON Schema

### Requirement: Config SHALL accept an optional `review_policy.ceiling_action` setting

`review_policy` SHALL accept an optional enum `ceiling_action` with the values
`park` and `demote_and_advance` that selects the behavior at the
`max_adversarial_rounds` round-budget ceiling (see
`review-ceiling-demote-and-advance`). It SHALL default to `park`, under which the
ceiling hard-parks at `needs-human` identically to behavior before this
capability. A value outside the enum SHALL be rejected at config-parse time. The
resolved value SHALL be exposed on the effective config so the review stage can
read it. Because it changes review-convergence behavior, the dotted path
`review_policy.ceiling_action` SHALL be present in `RIGOR_GATING_PATHS` and SHALL
resolve to a real property in the JSON Schema emitted by `pipeline config schema`.

#### Scenario: Setting defaults to park

- **WHEN** a repo declares no `review_policy.ceiling_action`
- **THEN** the resolved config SHALL carry `ceiling_action: "park"` and the round ceiling SHALL hard-park at `needs-human` unchanged from prior behavior

#### Scenario: Value accepted when declared

- **WHEN** a repo declares `review_policy.ceiling_action: demote_and_advance`
- **THEN** config resolution SHALL succeed and the effective config SHALL carry `ceiling_action: "demote_and_advance"`

#### Scenario: Out-of-enum value rejected

- **WHEN** `review_policy.ceiling_action` is set to a value other than `park` or `demote_and_advance`
- **THEN** config resolution SHALL fail with a validation error

#### Scenario: Path is registered as rigor-gating

- **WHEN** the `RIGOR_GATING_PATHS`-to-schema coherence test runs
- **THEN** `review_policy.ceiling_action` SHALL be present in `RIGOR_GATING_PATHS` and SHALL resolve to a real property in the emitted JSON Schema

### Requirement: Config SHALL accept an optional `review_policy.surface_recurrence_rounds` setting

`review_policy` SHALL accept an optional non-negative integer
`surface_recurrence_rounds` that sets the consecutive-round threshold `N` for the
`(file + category)` surface-recurrence guard (see `review-surface-recurrence`). It
SHALL default to `3`. A value of `0` SHALL disable the surface guard. A non-integer
or negative value SHALL be rejected at config-parse time. The resolved value SHALL
be exposed on the effective config so the review stage can read it. Because it
changes review-convergence behavior, the dotted path
`review_policy.surface_recurrence_rounds` SHALL be present in `RIGOR_GATING_PATHS`
and SHALL resolve to a real property in the JSON Schema emitted by
`pipeline config schema`.

#### Scenario: Setting defaults to 3

- **WHEN** a repo declares no `review_policy.surface_recurrence_rounds`
- **THEN** the resolved config SHALL carry `surface_recurrence_rounds: 3`

#### Scenario: Value accepted when declared

- **WHEN** a repo declares `review_policy.surface_recurrence_rounds: 4`
- **THEN** config resolution SHALL succeed and the effective config SHALL carry `surface_recurrence_rounds: 4`

#### Scenario: Zero disables the guard

- **WHEN** a repo declares `review_policy.surface_recurrence_rounds: 0`
- **THEN** config resolution SHALL succeed with `surface_recurrence_rounds: 0` and the surface guard SHALL be disabled

#### Scenario: Non-integer or negative value rejected

- **WHEN** `review_policy.surface_recurrence_rounds` is set to a non-integer or a negative number
- **THEN** config resolution SHALL fail with a validation error

#### Scenario: Path is registered as rigor-gating

- **WHEN** the `RIGOR_GATING_PATHS`-to-schema coherence test runs
- **THEN** `review_policy.surface_recurrence_rounds` SHALL be present in `RIGOR_GATING_PATHS` and SHALL resolve to a real property in the emitted JSON Schema

### Requirement: Config SHALL accept an optional strict `auto_loop` block

`PartialConfigSchema` SHALL accept an optional `auto_loop` block with strict validation. Its fields SHALL be: `enabled` (boolean, default `false`), `max_rounds` (positive integer), `max_wallclock_minutes` (positive integer), and `stages` (array of pipeline stage names drawn from `STAGES`). An unknown sub-key, a wrong type, or a `stages` entry that is not a recognized stage name SHALL cause `resolveConfig()` to throw a parse error identifying the offending key, consistent with the strict-block validation used for other feature blocks. When the block is absent, `auto_loop` SHALL resolve to its `DEFAULT_CONFIG` value (disabled), and the advance loop's behavior SHALL be unchanged.

The `auto_loop` block SHALL NOT provide any key that enables merging, deploying, publishing, disabling a protected/review step, or otherwise weakening a safety floor — it governs only bounded continuation of existing pipeline-owned recovery. The never-auto-merge guarantee remains structural and is not reachable through `auto_loop`.

#### Scenario: valid auto_loop block resolves

- **WHEN** `.github/pipeline.yml` sets `auto_loop:` with `enabled: true`, `max_rounds: 4`, `max_wallclock_minutes: 30`, and `stages: [eval-gate, shipcheck-gate]`
- **THEN** `resolveConfig()` SHALL resolve `cfg.auto_loop` to those values

#### Scenario: auto_loop absent uses disabled default

- **WHEN** `.github/pipeline.yml` has no `auto_loop` block
- **THEN** `cfg.auto_loop` SHALL equal `DEFAULT_CONFIG.auto_loop` with `enabled: false`

#### Scenario: unknown auto_loop sub-key rejected

- **WHEN** `.github/pipeline.yml` sets an unrecognized key under `auto_loop` (e.g. `auto_merge: true` or `max_minutes: 5`)
- **THEN** `resolveConfig()` SHALL throw a parse error identifying the offending key

#### Scenario: invalid budget value rejected

- **WHEN** `auto_loop.max_rounds` is set to a non-positive or non-integer value
- **THEN** `resolveConfig()` SHALL throw a parse error identifying `max_rounds`

#### Scenario: unknown stage in allowlist rejected

- **WHEN** `auto_loop.stages` contains a value that is not a member of `STAGES`
- **THEN** `resolveConfig()` SHALL throw a parse error identifying the invalid stage entry

### Requirement: The config schema SHALL accept `intake_timeout` and `sweep_timeout` keys

`PartialConfigSchema` SHALL include two new optional positive-integer keys:
`intake_timeout` (seconds for the intake harness call before timing out) and
`sweep_timeout` (seconds for the sweep harness call before timing out). Both SHALL
be validated as positive integers at parse time; a non-integer or non-positive value
SHALL cause `resolveConfig()` to throw with a parse error identifying the offending
field. When absent, both SHALL default to 600 seconds via `DEFAULT_CONFIG`.

#### Scenario: Both keys absent — defaults applied

- **WHEN** `.github/pipeline.yml` does not set `intake_timeout` or `sweep_timeout`
- **THEN** `cfg.intake_timeout` SHALL equal 600
- **AND** `cfg.sweep_timeout` SHALL equal 600

#### Scenario: File sets `intake_timeout`

- **WHEN** `.github/pipeline.yml` sets `intake_timeout: 300`
- **THEN** `cfg.intake_timeout` SHALL equal 300
- **AND** `cfg.sweep_timeout` SHALL still equal 600 (the default)

#### Scenario: Non-positive value rejected

- **WHEN** `.github/pipeline.yml` sets `intake_timeout: 0`
- **THEN** `resolveConfig()` SHALL throw a parse error identifying `intake_timeout` as the offending field

#### Scenario: Non-integer value rejected

- **WHEN** `.github/pipeline.yml` sets `sweep_timeout: "fast"`
- **THEN** `resolveConfig()` SHALL throw a parse error identifying `sweep_timeout` as the offending field

### Requirement: Config SHALL accept an optional plan_review_timeout key
`PartialConfigSchema` SHALL accept an optional positive-integer key `plan_review_timeout`
representing the wall-clock cap in seconds for the plan-review harness invocation.
`PipelineConfig` SHALL include `plan_review_timeout: number`. `DEFAULT_CONFIG` SHALL set
it to `300`. An absent key SHALL resolve to `300` seconds. A non-integer or non-positive
value SHALL cause `resolveConfig()` to throw with a parse error identifying the
offending field.

#### Scenario: plan_review_timeout absent — default 300 s applied
- **WHEN** `.github/pipeline.yml` does not set `plan_review_timeout`
- **THEN** `cfg.plan_review_timeout` SHALL equal 300

#### Scenario: File sets plan_review_timeout
- **WHEN** `.github/pipeline.yml` sets `plan_review_timeout: 600`
- **THEN** `cfg.plan_review_timeout` SHALL equal 600
- **AND** other timeout fields SHALL be unchanged

#### Scenario: Non-positive value rejected
- **WHEN** `.github/pipeline.yml` sets `plan_review_timeout: 0`
- **THEN** `resolveConfig()` SHALL throw a parse error identifying `plan_review_timeout`
  as the offending field

#### Scenario: Non-integer value rejected
- **WHEN** `.github/pipeline.yml` sets `plan_review_timeout: "fast"`
- **THEN** `resolveConfig()` SHALL throw a parse error identifying `plan_review_timeout`
  as the offending field

