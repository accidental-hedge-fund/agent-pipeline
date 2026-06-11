## ADDED Requirements

### Requirement: --status is stage-conditionally enriched for needs-human
The `--status` command SHALL print a stage-specific punch-list when the resolved stage is `needs-human`. For all other stages, `--status` output SHALL be identical to the pre-existing behavior.

#### Scenario: status on needs-human stage
- **WHEN** `--status` is invoked
- **AND** the issue carries the `pipeline:needs-human` label
- **THEN** the status output SHALL include the unresolved blocking-finding count and the resume steps (see `needs-human-status-surface`)
- **AND** SHALL exit 0 without any mutation to the issue

#### Scenario: status on all other stages is unchanged
- **WHEN** `--status` is invoked
- **AND** the resolved stage is any value other than `needs-human`
- **THEN** the output SHALL be identical to the pre-change behavior for that stage
