## MODIFIED Requirements

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

## ADDED Requirements

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
