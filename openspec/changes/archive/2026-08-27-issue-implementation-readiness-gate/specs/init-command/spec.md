## ADDED Requirements

### Requirement: Init SHALL create the pipeline:needs-spec label with the other pipeline stage labels

`ensurePipelineLabels` SHALL include `pipeline:needs-spec` in the managed label set. `pipeline init` SHALL create that label when it is missing and SHALL leave it unchanged when it already exists.

#### Scenario: Missing needs-spec label is created

- **WHEN** `init` is run on a repo that has other pipeline stage labels but not `pipeline:needs-spec`
- **THEN** `pipeline:needs-spec` SHALL be created
- **AND** existing labels SHALL be left unchanged

#### Scenario: Desired label list includes needs-spec

- **WHEN** the desired pipeline label list is inspected
- **THEN** it SHALL contain `pipeline:needs-spec`

### Requirement: Init scaffold SHALL document the issue_readiness block

When `init` writes a new `.github/pipeline.yml`, the scaffold SHALL document `issue_readiness`, including `enabled` (default `false`) and `timeout` (default `600`, unit seconds). The documented default SHALL keep the gate disabled so a fresh scaffold still matches `DEFAULT_CONFIG` for active values.

#### Scenario: Scaffold documents issue_readiness as default-off

- **WHEN** `init` scaffolds `.github/pipeline.yml` in a repo with no existing config
- **THEN** the file SHALL document `issue_readiness.enabled` and `issue_readiness.timeout`
- **AND** uncommented active values SHALL leave `issue_readiness.enabled` false (or omit the block equivalently)
