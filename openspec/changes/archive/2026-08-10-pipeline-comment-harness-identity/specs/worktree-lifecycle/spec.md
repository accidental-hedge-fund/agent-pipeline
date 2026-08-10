## MODIFIED Requirements

### Requirement: Pipeline labels are bootstrapped idempotently
`ensurePipelineLabels` SHALL idempotently create the labels the state machine relies on: `blocked`, one `harness:<name>` label for every built-in harness-adapter name shipped with the engine (at least `claude`, `codex`, `grok`, `opencode`, and `pi`), and one `pipeline:<stage>` label per entry in `STAGES`. Re-running SHALL create no duplicates.

#### Scenario: labels ensured
- **WHEN** `ensurePipelineLabels` runs against a repo missing some pipeline labels
- **THEN** the missing labels SHALL be created and already-present labels SHALL be left unchanged

#### Scenario: built-in harness labels are included
- **WHEN** `ensurePipelineLabels` runs against a repo missing `harness:grok`, `harness:opencode`, or `harness:pi`
- **THEN** each missing built-in harness label SHALL be created
