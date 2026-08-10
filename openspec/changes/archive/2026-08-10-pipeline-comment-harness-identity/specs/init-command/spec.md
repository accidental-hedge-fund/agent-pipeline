## MODIFIED Requirements

### Requirement: Init ensures all pipeline labels idempotently
The `init` command SHALL call `ensurePipelineLabels` for the target repo, creating any missing labels and leaving existing labels unchanged.

#### Scenario: Labels do not exist yet
- **WHEN** `init` is run on a repo with no pipeline labels
- **THEN** all pipeline labels (`pipeline:<stage>`, `pipeline:blocked` / `blocked`, and `harness:<name>` for every built-in harness-adapter name including at least `claude`, `codex`, `grok`, `opencode`, and `pi`) are created in the repo

#### Scenario: Labels already exist
- **WHEN** `init` is run on a repo where all pipeline labels already exist
- **THEN** no labels are modified, no errors are thrown, and the command exits successfully

#### Scenario: Some labels exist, some are missing
- **WHEN** `init` is run and only a subset of pipeline labels are present
- **THEN** only the missing labels are created; existing labels are left unchanged
