# generated-config-reference Specification

## Purpose
TBD - created by archiving change docs-generated-cli-config-reference. Update Purpose after archive.
## Requirements
### Requirement: Config reference documentation SHALL be generated from the Zod config schema

The repository SHALL provide a deterministic generator that emits `docs/config.md` from the Zod schema surface that validates `.github/pipeline.yml` (`PartialConfigSchema` in `config.ts` and any nested schemas it composes). For each documented top-level config key, the generated reference SHALL include a human-readable description consistent with the schema's `.describe()` text (or equivalent schema description) and SHALL reflect the key's type constraints (including enums where present). The generator SHALL NOT document keys that the schema rejects (for example `auto_merge`).

#### Scenario: Top-level keys appear with descriptions

- **WHEN** the config reference generator runs
- **THEN** `docs/config.md` SHALL include entries for known top-level keys such as `base_branch`, `review_policy`, `steps`, and `eval_gate`
- **AND** each such entry SHALL carry a non-empty description consistent with the schema description for that key

#### Scenario: Enum-typed fields surface allowed values

- **WHEN** the schema defines an enum-typed field (for example `review_policy.block_threshold` or `eval_gate.mode`)
- **THEN** the generated `docs/config.md` entry for that field SHALL list the allowed enum values

#### Scenario: Rejected keys are not documented as valid

- **WHEN** the config reference is generated
- **THEN** `docs/config.md` SHALL NOT present `auto_merge` as a supported configuration key

#### Scenario: Schema change is reflected without a separate hand edit of docs/config.md

- **WHEN** a field is added to or removed from `PartialConfigSchema` and the generator is re-run
- **THEN** the newly generated `docs/config.md` SHALL reflect that addition or removal without requiring a hand-maintained parallel field list

---

### Requirement: Committed config reference artifacts SHALL be staleness-gated in CI

The repository SHALL provide a check mode for the config reference generator that exits non-zero when the committed `docs/config.md` differs from a fresh generation. That check SHALL be invoked from the root `npm run ci` gate (directly or via the same composed docs-check step as the CLI reference check).

#### Scenario: Stale docs/config.md fails the check

- **WHEN** `docs/config.md` no longer matches a fresh generation from the schema
- **THEN** the docs generator check mode SHALL exit non-zero

#### Scenario: Fresh generation passes the check

- **WHEN** committed `docs/config.md` matches a fresh generation run
- **THEN** the docs generator check mode SHALL exit zero for that artifact

