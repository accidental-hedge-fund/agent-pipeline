## ADDED Requirements

### Requirement: Checkpoint fires before a declared stage is dispatched
When the advance loop is about to dispatch a stage whose name is listed in `approval_checkpoints` AND the issue does not carry `pipeline:awaiting-approval`, the pipeline SHALL post a checkpoint comment on the PR, apply the `pipeline:awaiting-approval` label, and return `{ advanced: false, status: "waiting" }` without dispatching the stage.

#### Scenario: checkpoint fires on first encounter
- **WHEN** the advance loop resolves the next stage as `implementing`
- **AND** `approval_checkpoints` includes `"implementing"`
- **AND** the issue does NOT carry `pipeline:awaiting-approval`
- **THEN** the pipeline SHALL post a `## Pipeline: Awaiting Approval` comment on the PR containing the stage name, the short SHA (first 7 chars), and the `<!-- checkpoint-sha: <full-sha> -->` sentinel
- **AND** SHALL apply the `pipeline:awaiting-approval` label to the issue
- **AND** SHALL return `{ advanced: false, status: "waiting" }` (advance loop stops)
- **AND** SHALL NOT dispatch the `implementing` stage handler

#### Scenario: no checkpoint stages declared — fully autonomous
- **WHEN** `approval_checkpoints` is empty (default)
- **AND** the advance loop resolves the next stage as any stage
- **THEN** no checkpoint comment SHALL be posted
- **AND** no `pipeline:awaiting-approval` label SHALL be applied
- **AND** the stage SHALL be dispatched normally

### Requirement: Pending checkpoint stays waiting when SHA is unchanged
When the advance loop encounters a stage listed in `approval_checkpoints` AND the issue carries `pipeline:awaiting-approval`, the pipeline SHALL locate the most recent `## Pipeline: Awaiting Approval` comment on the PR, extract its `<!-- checkpoint-sha: <sha> -->` sentinel, and compare it to the current HEAD SHA. If the SHAs match, the pipeline SHALL return `{ advanced: false, status: "waiting" }` without re-issuing the comment.

#### Scenario: awaiting-approval label present, SHA unchanged
- **WHEN** the advance loop resolves the next stage as `implementing`
- **AND** `approval_checkpoints` includes `"implementing"`
- **AND** the issue carries `pipeline:awaiting-approval`
- **AND** the most recent `## Pipeline: Awaiting Approval` comment has a `<!-- checkpoint-sha: <sha> -->` sentinel matching the current HEAD SHA
- **THEN** the pipeline SHALL NOT post a new checkpoint comment
- **AND** SHALL return `{ advanced: false, status: "waiting" }`

### Requirement: Stale checkpoint is re-issued when branch HEAD advances
When the advance loop encounters a pending checkpoint (label present) and the HEAD SHA has changed since the checkpoint comment was posted, the pipeline SHALL re-issue the checkpoint comment against the new HEAD SHA (with a brief notice that the branch advanced) and SHALL keep the `pipeline:awaiting-approval` label, returning `{ advanced: false, status: "waiting" }`.

#### Scenario: awaiting-approval label present, SHA changed
- **WHEN** the advance loop resolves the next stage as `implementing`
- **AND** `approval_checkpoints` includes `"implementing"`
- **AND** the issue carries `pipeline:awaiting-approval`
- **AND** the most recent `## Pipeline: Awaiting Approval` comment has a `<!-- checkpoint-sha: <old-sha> -->` sentinel that does NOT match the current HEAD SHA
- **THEN** the pipeline SHALL post a new `## Pipeline: Awaiting Approval` comment noting the branch advanced and containing the new `<!-- checkpoint-sha: <new-sha> -->` sentinel
- **AND** SHALL keep the `pipeline:awaiting-approval` label
- **AND** SHALL return `{ advanced: false, status: "waiting" }`

#### Scenario: awaiting-approval label present, no checkpoint comment found
- **WHEN** the issue carries `pipeline:awaiting-approval`
- **AND** no `## Pipeline: Awaiting Approval` comment exists on the PR
- **THEN** the pipeline SHALL re-issue the checkpoint comment as if it were the first encounter
- **AND** SHALL keep the `pipeline:awaiting-approval` label
- **AND** SHALL return `{ advanced: false, status: "waiting" }`

### Requirement: Checkpoint cleared — stage dispatches normally after label removal
When the advance loop resolves a stage listed in `approval_checkpoints` AND the issue does NOT carry `pipeline:awaiting-approval` (the human removed it), the pipeline SHALL dispatch the stage handler normally without issuing a new checkpoint comment.

#### Scenario: human removes awaiting-approval label and re-invokes
- **WHEN** the issue previously had `pipeline:awaiting-approval` applied by a checkpoint
- **AND** a human has since removed the `pipeline:awaiting-approval` label
- **AND** the pipeline is re-invoked
- **AND** the current stage is the same checkpoint stage (e.g. `implementing`)
- **THEN** the pipeline SHALL dispatch the `implementing` stage handler
- **AND** SHALL NOT post a new checkpoint comment
- **AND** SHALL NOT re-apply the `pipeline:awaiting-approval` label

### Requirement: Checkpoint comment contains required resume instructions
Every `## Pipeline: Awaiting Approval` comment SHALL include a "How to approve" section instructing the human to remove the `pipeline:awaiting-approval` label and re-invoke the pipeline.

#### Scenario: checkpoint comment body
- **WHEN** the pipeline posts a `## Pipeline: Awaiting Approval` comment
- **THEN** the comment body SHALL contain:
  - The stage name awaiting approval
  - The short HEAD SHA (first 7 characters)
  - The `<!-- checkpoint-sha: <full-sha> -->` HTML sentinel on its own line
  - A "### How to approve" section instructing: remove the `pipeline:awaiting-approval` label, then re-invoke the pipeline

### Requirement: Checkpoint config validates stage names at config-load time
`resolveConfig()` SHALL reject any `approval_checkpoints` entry that is not a member of `STAGES`, or that equals `"backlog"` or `"ready-to-deploy"`. An invalid entry SHALL cause `resolveConfig()` to throw a descriptive parse error.

#### Scenario: valid stage name accepted
- **WHEN** `.github/pipeline.yml` sets `approval_checkpoints: ["implementing", "pre-merge"]`
- **THEN** `resolveConfig()` SHALL succeed and expose `config.approvalCheckpoints` as `["implementing", "pre-merge"]`

#### Scenario: unknown stage name rejected
- **WHEN** `.github/pipeline.yml` sets `approval_checkpoints: ["implmenting"]` (typo)
- **THEN** `resolveConfig()` SHALL throw with a parse error identifying the invalid stage name

#### Scenario: terminal or initial stage rejected
- **WHEN** `.github/pipeline.yml` sets `approval_checkpoints: ["ready-to-deploy"]`
- **THEN** `resolveConfig()` SHALL throw with a parse error identifying `"ready-to-deploy"` as not a valid checkpoint stage
