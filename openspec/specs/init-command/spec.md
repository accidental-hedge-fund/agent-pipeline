# init-command Specification

## Purpose
TBD - created by archiving change init-command-scaffold-pipeline-config. Update Purpose after archive.
## Requirements
### Requirement: Init command runs without an issue number
The pipeline CLI SHALL accept `init` as a sub-command that requires no issue number argument and that does not advance any pipeline stage.

#### Scenario: Invoked with no issue number
- **WHEN** the user runs `/pipeline init` (or `$pipeline init`)
- **THEN** the command exits successfully without touching any issue, PR, or pipeline stage label

#### Scenario: Invoked with an issue number (invalid)
- **WHEN** the user runs `/pipeline init 42`
- **THEN** the command ignores the trailing argument and still only performs init work (or prints an error and exits — implementations may choose either; the key constraint is no stage advance occurs)

---

### Requirement: Init ensures all pipeline labels idempotently
The `init` command SHALL call `ensurePipelineLabels` for the target repo, creating any missing labels and leaving existing labels unchanged.

#### Scenario: Labels do not exist yet
- **WHEN** `init` is run on a repo with no pipeline labels
- **THEN** all pipeline labels (`pipeline:<stage>`, `pipeline:blocked`, `harness:claude`, `harness:codex`) are created in the repo

#### Scenario: Labels already exist
- **WHEN** `init` is run on a repo where all pipeline labels already exist
- **THEN** no labels are modified, no errors are thrown, and the command exits successfully

#### Scenario: Some labels exist, some are missing
- **WHEN** `init` is run and only a subset of pipeline labels are present
- **THEN** only the missing labels are created; existing labels are left unchanged

---

### Requirement: Init scaffolds `.github/pipeline.yml` when absent

The `init` command SHALL write a `.github/pipeline.yml` starter template when no such file exists
in the target repo. The template SHALL be an exhaustive, accurate, self-documenting representation
of the config schema: every top-level and nested property accepted by the strict config schema
(`PartialConfigSchema`) SHALL appear, either active at its resolved `DEFAULT_CONFIG` value or as a
commented opt-in example. Options whose default is absence SHALL be documented with the applicable
semantic (`absent`, `disabled`, `auto-detected`, `unlimited`, or equivalent) rather than an
invented placeholder default. Each option SHALL state what it controls and when it takes effect;
enum options SHALL list every accepted value; numeric options SHALL document unit, bounds, and any
special value; array/map options SHALL document their valid shape and at least one representative
example. The previously-omitted keys `repo`, `domain_name`, `domain_description`,
`conventions_md_path`, `roadmap`, `sweep`, `queue`, `trusted_override_actors`,
`auto_merge_eligibility`, `context_snapshot`, and `design_gate` SHALL be represented. A fresh
scaffold SHALL still parse and validate via `resolveConfig` without modification and equal
`DEFAULT_CONFIG` for every key present as an active value.

#### Scenario: Config file does not exist

- **WHEN** `init` is run and `.github/pipeline.yml` is absent
- **THEN** a `.github/pipeline.yml` file is written documenting every accepted schema property
- **AND** a success message is printed indicating the file was created

#### Scenario: Scaffolded config is valid against the schema

- **WHEN** the scaffolded `.github/pipeline.yml` is parsed by `resolveConfig`
- **THEN** `resolveConfig` returns without throwing
- **AND** the resulting config matches `DEFAULT_CONFIG` for every key present as an active (non-commented) value

#### Scenario: Previously-omitted keys are represented

- **WHEN** `init` scaffolds `.github/pipeline.yml` in a repo with no existing config
- **THEN** the file SHALL contain documentation for `repo`, `domain_name`, `domain_description`, `conventions_md_path`, `roadmap`, `sweep`, `queue`, `trusted_override_actors`, `auto_merge_eligibility`, `context_snapshot`, and `design_gate`
- **AND** each SHALL appear either as an active default or as a commented opt-in example

#### Scenario: Absence-default keys document absence, not a placeholder

- **WHEN** `init` scaffolds a key whose resolved default is absence (for example `repo`, `event_sink`, `queue`, or `auto_merge_eligibility`)
- **THEN** the documentation SHALL state the applicable absence/auto-detection semantic (`absent`, `disabled`, `auto-detected`, or `unlimited`)
- **AND** SHALL NOT present an invented active default value

#### Scenario: Uncommenting a documented example yields a schema-valid value

- **WHEN** an operator uncomments any single documented opt-in example in the scaffolded file
- **THEN** the resulting `.github/pipeline.yml` SHALL parse and validate via `resolveConfig` without error

---

### Requirement: Init does not clobber an existing `.github/pipeline.yml`
If `.github/pipeline.yml` already exists, `init` SHALL skip the scaffolding step and print a clear notice, then continue to ensure labels.

#### Scenario: Config file already exists
- **WHEN** `init` is run and `.github/pipeline.yml` is already present
- **THEN** the existing file is not modified
- **AND** a notice is printed such as: `.github/pipeline.yml already exists — skipping scaffold`
- **AND** label ensure still runs and completes successfully

---

### Requirement: Init is idempotent and safe to re-run
Running `init` multiple times on the same repo SHALL produce the same observable state each time, with no errors.

#### Scenario: Re-run after first init
- **WHEN** `init` is run a second time on a repo where `init` was already run
- **THEN** existing labels are left unchanged, the existing config file is preserved, and the command exits successfully

---

### Requirement: Normal pipeline advance still self-creates labels
When a user runs `/pipeline N` (the advance path) without having run `init` first, `ensurePipelineLabels` SHALL still be called as it is today. `init` is additive and introduces no new precondition for normal pipeline use.

#### Scenario: Advance run on a repo with no prior init
- **WHEN** `/pipeline 42` is run on a repo where `init` was never called
- **THEN** labels are created during the advance run exactly as before this change

---

### Requirement: README documents `init` as the recommended first step
The README SHALL include a section explaining `init` as the recommended onboarding command for a fresh repo, showing the invocation and summarizing what it does.

#### Scenario: New adopter reads the README
- **WHEN** a user reads the README to onboard a new repo
- **THEN** they find a clear description of `init`, its invocation, and what it sets up (labels + starter config)

---

### Requirement: Unit tests cover init behavior
The implementation SHALL include unit tests for: (1) label-ensure path, (2) scaffold-config-when-absent, (3) no-clobber-when-present, (4) scaffolded-config validity via round-trip through `resolveConfig`.

#### Scenario: Tests pass in CI
- **WHEN** `pnpm test` is run
- **THEN** all four test cases pass without errors

### Requirement: Init scaffolds a commented-out documented `repo_map` block

The `.github/pipeline.yml` scaffolded by `init` (and by `config sync`) SHALL include a
`repo_map` block that is commented out by default, with inline documentation describing the
two relationship lists (`depends_on`, `depended_on_by`), the `owner/repo` entry format, and
that the relationship is declared independently per repo. Because the block is commented out,
the scaffolded file SHALL still round-trip through `resolveConfig()` to the `repo_map` default
(both lists empty), preserving the existing "scaffolded config equals defaults" guarantee.

#### Scenario: scaffolded config contains the documented repo_map block

- **WHEN** `init` scaffolds `.github/pipeline.yml`
- **THEN** the file SHALL contain a commented-out `repo_map` block
- **AND** the block's comments SHALL document `depends_on`, `depended_on_by`, and the `owner/repo` entry format

#### Scenario: scaffolded repo_map keeps the config valid against defaults

- **WHEN** the scaffolded `.github/pipeline.yml` is parsed by `resolveConfig()`
- **THEN** parsing SHALL succeed
- **AND** `config.repo_map.depends_on` SHALL equal `[]`
- **AND** `config.repo_map.depended_on_by` SHALL equal `[]`

### Requirement: Init ensures the engine-managed `.gitignore` artifact block

The `init` command SHALL ensure the engine-managed artifact ignore block in the target
repository's root `.gitignore`, in addition to ensuring labels and scaffolding
`.github/pipeline.yml`. The step SHALL create the `.gitignore` if absent, append the managed
block if the block is missing, and refresh only the block's contents when it is present and
stale. It SHALL never modify lines outside the block. `init` SHALL print a distinct message
for each outcome (created / updated / already current). The ignore step SHALL NOT change
`init`'s existing no-clobber behavior for `.github/pipeline.yml`.

#### Scenario: Fresh repo with no `.gitignore`

- **WHEN** `pipeline init` is run in a repository with no root `.gitignore`
- **THEN** a root `.gitignore` SHALL be created containing the managed artifact block
- **AND** a message SHALL be printed indicating the file was created
- **AND** labels and the `.github/pipeline.yml` scaffold SHALL still be ensured as before

#### Scenario: Repo with an existing `.gitignore`

- **WHEN** `pipeline init` is run in a repository whose `.gitignore` has operator-authored entries and no managed block
- **THEN** the managed block SHALL be appended
- **AND** the operator's existing entries SHALL remain byte-identical

#### Scenario: Re-running init after an engine upgrade adds an artifact directory

- **WHEN** `pipeline init` is re-run after the artifact contract gained a new directory
- **THEN** only the managed block SHALL be rewritten so it lists the new entry
- **AND** a message SHALL be printed indicating the block was updated

#### Scenario: Init is idempotent for the ignore block

- **WHEN** `pipeline init` is run twice in succession with no contract change in between
- **THEN** the second run SHALL perform no write to `.gitignore`
- **AND** a message SHALL be printed indicating the block is already current
- **AND** the command SHALL exit successfully

#### Scenario: Ignore step does not alter config scaffold behavior

- **WHEN** `pipeline init` is run in a repository that already has `.github/pipeline.yml`
- **THEN** the existing config file SHALL remain unmodified and the skip notice SHALL still be printed
- **AND** the `.gitignore` managed block SHALL still be ensured

### Requirement: The scaffolded `models:` comment SHALL document the post-passthrough reviewer contract

The `.github/pipeline.yml` scaffold written by `init` (and used as the structural baseline by `config sync`) SHALL describe the current reviewer-model contract: the `review` alias is passed
through to both built-in reviewer harnesses (`claude` via `--model`, `codex` via
`codex exec -m`), and a Claude-only alias configured against a codex reviewer is rejected at
config-parse time. The comment SHALL NOT state that codex ignores the reviewer alias or that
setting it merely prints a warning. The implementer-role keys
(`planning`/`implementing`/`fix`) SHALL continue to be documented as inert on a codex
implementer.

#### Scenario: Freshly scaffolded config documents the current contract

- **WHEN** `pipeline init` scaffolds `.github/pipeline.yml` in a repo with no existing config
- **THEN** the `models:` comment SHALL state that `review` is honored by both built-in reviewer harnesses
- **AND** it SHALL state that a Claude alias (`sonnet`/`opus`/`haiku`/`claude-*`) with a codex reviewer is a config error
- **AND** it SHALL NOT claim the reviewer alias is ignored by codex

#### Scenario: config sync refreshes an existing file to the corrected comment

- **WHEN** `config sync` is applied to a valid existing `.github/pipeline.yml` carrying the pre-passthrough `models:` comment
- **THEN** the refreshed file SHALL carry the corrected comment text
- **AND** the file's explicitly configured values SHALL be preserved unchanged

### Requirement: Config sync uses the current init scaffold without changing init no-clobber behavior

The starter structure used by config sync SHALL be the same current structure used when
`pipeline init` creates a new `.github/pipeline.yml`, so `config sync` SHALL introduce
newly-added commented options and refreshed guidance into an existing config while preserving the
operator's explicitly set values and unrelated comments/formatting. Config sync SHALL refuse to
write when the re-rendered candidate would change effective configuration. The init command SHALL
continue to preserve existing config files without modifying them.

#### Scenario: Sync baseline follows init scaffold

- **WHEN** the starter config template changes for newly initialized repositories
- **THEN** config sync SHALL use that same updated starter structure as its refresh baseline

#### Scenario: Sync introduces newly-added documented options

- **WHEN** the schema gains a new documented option and `config sync` is applied to an existing valid `.github/pipeline.yml`
- **THEN** the refreshed file SHALL include the new option's commented documentation and any refreshed guidance
- **AND** the operator's explicitly configured values SHALL be preserved unchanged

#### Scenario: Sync refuses to change effective configuration

- **WHEN** `config sync` re-renders an existing config and the candidate would change the effective configuration
- **THEN** config sync SHALL refuse to write the candidate and report the condition

#### Scenario: Init still skips existing config

- **WHEN** `pipeline init` is run in a repository that already has `.github/pipeline.yml`
- **THEN** init SHALL leave the existing file unchanged
- **AND** it SHALL NOT invoke config sync implicitly

### Requirement: Template documentation and schema descriptions share one field-metadata source

The scaffold documentation and the `pipeline config schema` descriptions SHALL be derived from a
single shared field-metadata source of truth, so that adding a new config field to that source is
sufficient to make it appear — with its description, default/absence semantics, example, and
security note where applicable — in both `pipeline config schema` output and the `init` template.
There SHALL NOT be a second hand-maintained option inventory that must be updated separately from
the schema.

#### Scenario: A new field surfaces in both outputs from one edit

- **WHEN** a new config field is added to the shared field-metadata source
- **THEN** `pipeline config schema` SHALL emit a description for that field
- **AND** the `init` template SHALL document that field (default/absence semantics + example, plus a security note where applicable)
- **AND** no separate second option inventory SHALL require a parallel edit

### Requirement: Recursive schema-to-template drift test guards coverage

The implementation SHALL include a test that walks `PartialConfigSchema` recursively — covering
top-level and nested object properties — and fails when any accepted property path is absent from
the rendered template documentation. A test that only searches top-level key strings is
insufficient and SHALL NOT be relied upon as the coverage guard.

#### Scenario: Missing nested property fails the drift test

- **WHEN** an accepted top-level or nested schema property is not documented in the rendered template
- **THEN** the drift test SHALL fail identifying the undocumented property path

#### Scenario: New schema field without template documentation fails CI

- **WHEN** a field is added to `PartialConfigSchema` but not documented in the template
- **THEN** the drift test SHALL fail so the omission cannot merge silently

### Requirement: Defaults-parity test guards documented defaults

The implementation SHALL include a test that fails when a documented active default diverges from
`DEFAULT_CONFIG`, or when a field documented as having a concrete default is instead one whose
declared semantic is absence/auto-detection (and vice versa). Because the core runs via
type-stripping with no `tsc` check, this invariant SHALL be enforced by a runtime test.

#### Scenario: Divergent documented default fails the parity test

- **WHEN** a documented active default value differs from the corresponding `DEFAULT_CONFIG` value
- **THEN** the defaults-parity test SHALL fail identifying the diverging field

#### Scenario: Absence semantics respected

- **WHEN** a field's default is absence/auto-detected
- **THEN** the parity test SHALL require its documentation to state that semantic rather than a concrete default value

### Requirement: Harness-applicability documentation is accurate for harness-routing keys

The scaffold SHALL document `models`, `effort`, `review_harness`, `executors`, and
`stage_executors` with accurate harness applicability, including which combinations are inert. The
documentation SHALL reflect that the `review` alias is passed through to both built-in reviewer
harnesses and that implementer-role keys (`planning`/`implementing`/`fix`) are inert on a codex
implementer, and SHALL describe which stages an external executor may serve.

#### Scenario: Reviewer-alias and implementer-role applicability documented

- **WHEN** `init` scaffolds the `models` block
- **THEN** the documentation SHALL state that `review` is honored by both built-in reviewer harnesses
- **AND** SHALL state that `planning`/`implementing`/`fix` are inert on a codex implementer

#### Scenario: Executor applicability documented

- **WHEN** `init` scaffolds the `executors`/`stage_executors` blocks
- **THEN** the documentation SHALL describe which stages an external executor may serve and note that unassigned stages use the local harness unchanged

### Requirement: Security notes accompany security-sensitive opt-in options

The scaffold SHALL attach a concise security / blast-radius note to each security-sensitive opt-in
option class: mutation/authority (e.g. `trusted_override_actors`), external execution (e.g.
`executors`/`stage_executors`, `setup_command`, `build_command`, `format_gate` commands),
secret/auth (executor `credential`, endpoint headers), telemetry (`event_sink`), sandbox
(`harness_sandbox`), auto-loop (`auto_loop`), and auto-merge-eligibility
(`auto_merge_eligibility`).

#### Scenario: Opt-in security classes carry a note

- **WHEN** `init` scaffolds a security-sensitive opt-in option in one of the enumerated classes
- **THEN** its documentation SHALL include a concise security or blast-radius note

#### Scenario: Secret references never embed literal values

- **WHEN** `init` documents an option that references a secret or credential
- **THEN** the example SHALL show an env-var name (or secret reference), never a literal secret value

### Requirement: The scaffold's opening claim is mechanically accurate

The generated `.github/pipeline.yml` opening claim SHALL be mechanically true against the rendered
coverage, or SHALL be replaced with narrower wording that accurately describes what the file
covers. The claim SHALL NOT assert full-coverage or every-key-shown semantics that the rendered
file does not satisfy.

#### Scenario: Opening claim matches coverage

- **WHEN** the scaffolded file is generated
- **THEN** its opening claim SHALL accurately describe the file's actual coverage of the config schema
- **AND** a test SHALL fail if the claim asserts coverage the rendered file does not provide

