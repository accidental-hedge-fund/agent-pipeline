# config-schema-command Specification

## Purpose
TBD - created by archiving change desktop-contract-config-schema-validate. Update Purpose after archive.
## Requirements
### Requirement: `pipeline config schema` prints JSON Schema derived from PartialConfigSchema

The `pipeline config schema` command SHALL print to stdout a JSON Schema (draft-07 or later) that is structurally derived from `PartialConfigSchema`. The schema SHALL be consistent with the Zod schema: same top-level keys, same types, same enum values, same required/optional distinction. The schema SHALL include a human-readable `description` for each top-level key (and sub-keys where feasible). The command SHALL exit 0 on success.

#### Scenario: schema printed to stdout

- **WHEN** the user runs `pipeline config schema`
- **THEN** valid JSON SHALL be printed to stdout
- **AND** the JSON SHALL be a JSON Schema object containing a `properties` key
- **AND** the schema SHALL include entries for known top-level keys such as `base_branch`, `review_policy`, `steps`, `eval_gate`, and `shipcheck_gate`
- **AND** the command SHALL exit 0

#### Scenario: schema includes enum constraints for enum-typed fields

- **WHEN** the user runs `pipeline config schema`
- **THEN** the schema entry for `review_policy.block_threshold` SHALL include `"enum": ["critical","high","medium","low"]`
- **AND** the schema entry for `eval_gate.mode` SHALL include `"enum": ["gate","advisory"]`
- **AND** the schema entry for `openspec.enabled` SHALL include `"enum": ["auto","on","off"]`

#### Scenario: schema marks optional keys as not required

- **WHEN** the user runs `pipeline config schema`
- **THEN** every top-level key in `.github/pipeline.yml` SHALL be absent from the schema's `required` array (all keys are optional)

#### Scenario: schema descriptions are present

- **WHEN** the user runs `pipeline config schema`
- **THEN** each top-level property SHALL carry a non-empty `description` string suitable for editor tooltip display

#### Scenario: schema is always in sync with PartialConfigSchema

- **WHEN** a field is added to or removed from `PartialConfigSchema` in `config.ts`
- **THEN** the schema emitted by `pipeline config schema` SHALL reflect that change without any separate update step

