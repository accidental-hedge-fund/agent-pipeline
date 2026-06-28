## ADDED Requirements

### Requirement: auto_merge_eligibility config block accepted in pipeline.yml
`PartialConfigSchema` SHALL accept an optional `auto_merge_eligibility` object with the following keys:

- `enabled` (boolean, default `false`): when `false`, the gate is a no-op
- `max_diff_lines` (positive integer, default `300`): hard-deny if total diff lines exceed this
- `max_files` (positive integer, default `10`): hard-deny if changed file count exceeds this
- `deny_paths` (array of glob strings, default `[]`): additional path patterns that always trigger `needs-human`
- `allow_paths` (array of glob strings, default `[]`): when non-empty, any changed file not covered by this list triggers `needs-human`
- `min_confidence` (number in `[0, 1]`, default `0.8`): LLM judge confidence floor; outputs below this route to `needs-human`

Any unknown key inside the `auto_merge_eligibility` block SHALL be rejected with a strict-schema parse error. All keys are optional; omitted keys SHALL take their default values.

#### Scenario: auto_merge_eligibility block accepted with valid keys
- **WHEN** `.github/pipeline.yml` sets `auto_merge_eligibility.enabled: true` and `auto_merge_eligibility.max_diff_lines: 200`
- **THEN** `resolveConfig()` SHALL succeed and `config.auto_merge_eligibility.enabled` SHALL be `true` and `config.auto_merge_eligibility.max_diff_lines` SHALL be `200`

#### Scenario: unknown key in auto_merge_eligibility block is rejected
- **WHEN** `.github/pipeline.yml` sets `auto_merge_eligibility.auto_approve: true`
- **THEN** `resolveConfig()` SHALL throw with a parse error identifying `auto_approve` as an unknown key

#### Scenario: omitted block defaults to disabled
- **WHEN** `.github/pipeline.yml` has no `auto_merge_eligibility` block
- **THEN** `config.auto_merge_eligibility.enabled` SHALL be `false`
- **AND** all other subfields SHALL take their default values

#### Scenario: min_confidence out of range is rejected
- **WHEN** `.github/pipeline.yml` sets `auto_merge_eligibility.min_confidence: 1.5`
- **THEN** `resolveConfig()` SHALL throw with a parse error identifying `min_confidence` as out of range
