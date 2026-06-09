# commit-traceability-trailers Specification

## Purpose
TBD - created by archiving change stamp-commits-issue-traceability. Update Purpose after archive.
## Requirements
### Requirement: Direct pipeline commits carry Issue and Pipeline-Run trailers

Every commit created directly by the pipeline (docs-update, openspec-archive, openspec-init) SHALL include the following two git trailers at the end of the commit message, separated from the subject/body by a blank line:

```
Issue: #<issueNumber>
Pipeline-Run: <pipelineRunId>
```

Where `<issueNumber>` is the GitHub issue number driving the pipeline run, and `<pipelineRunId>` is the run identifier generated at pipeline invocation time.

#### Scenario: Docs-update commit has trailers
- **WHEN** the pipeline creates a docs-update commit in `pre_merge.ts`
- **THEN** the commit message ends with a blank line followed by `Issue: #<n>` and `Pipeline-Run: <id>` trailers

#### Scenario: Openspec-archive commit has trailers
- **WHEN** the pipeline creates an openspec-archive commit in `pre_merge.ts`
- **THEN** the commit message ends with a blank line followed by `Issue: #<n>` and `Pipeline-Run: <id>` trailers

#### Scenario: Openspec-init commit has trailers
- **WHEN** the pipeline creates an openspec-init commit in `planning.ts`
- **THEN** the commit message ends with a blank line followed by `Issue: #<n>` and `Pipeline-Run: <id>` trailers

### Requirement: Harness-instructed commits are required to carry trailers

The implementing, fix, and test-fix prompt templates SHALL instruct the harness agent to append the following two trailers to the bottom of every commit message it creates:

```
Issue: #<issueNumber>
Pipeline-Run: <pipelineRunId>
```

The templates SHALL provide `{{issue_number}}` and `{{pipeline_run_id}}` as pre-filled values for the agent to use.

#### Scenario: Implementing prompt requires trailers
- **WHEN** the implementing prompt template is rendered
- **THEN** it contains an explicit instruction to add `Issue: #{{issue_number}}` and `Pipeline-Run: {{pipeline_run_id}}` trailers to every commit

#### Scenario: Fix prompt requires trailers
- **WHEN** the fix prompt template is rendered
- **THEN** it contains an explicit instruction to add `Issue: #{{issue_number}}` and `Pipeline-Run: {{pipeline_run_id}}` trailers to every commit

#### Scenario: Test-fix prompt requires trailers
- **WHEN** the test-fix prompt template is rendered
- **THEN** it contains an explicit instruction to add `Issue: #{{issue_number}}` and `Pipeline-Run: {{pipeline_run_id}}` trailers to every commit

### Requirement: Pipeline run ID is generated once per invocation and consistent across all commits

The pipeline orchestrator SHALL generate a `pipelineRunId` once at the start of processing an issue and reuse the same value for all commit operations during that invocation. The format SHALL be `<issueNumber>/<UTC-ISO-datetime>` (e.g., `42/2026-06-08T14:32:00Z`).

#### Scenario: Run ID is the same for all commits in a run
- **WHEN** the pipeline produces multiple commits for the same issue in one invocation (e.g., implementation commit + docs-update commit)
- **THEN** all commits carry the same `Pipeline-Run:` trailer value

#### Scenario: Run ID format is greppable
- **WHEN** a developer runs `git log --grep="Pipeline-Run: 42/"` on a repo's history
- **THEN** all commits from all pipeline runs on issue #42 appear in the results

### Requirement: Trailers are valid git trailer format

All trailers added by the pipeline SHALL conform to the git trailer specification: each trailer on its own line, using `Key: Value` format, placed at the end of the commit message, separated from any preceding body text by a blank line.

#### Scenario: git interpret-trailers parses the trailers correctly
- **WHEN** `git log --format="%(trailers:key=Issue)" HEAD` is run against a commit produced by the pipeline
- **THEN** the output contains the `Issue:` trailer value without error

