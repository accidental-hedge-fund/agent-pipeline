# idempotent-stage-audit Specification

## Purpose
Ensures that every pipeline stage transition and blocked-state write produces a durable, idempotent audit comment. If the comment post fails after the label write succeeds, a subsequent run detects and repairs the gap without posting a duplicate.

## ADDED Requirements

### Requirement: Transition comments SHALL embed an idempotency key
Every comment posted by `transition()` SHALL include an HTML sentinel of the form `<!-- pipeline-audit: run=<runId> state=<toStage> -->` appended to the comment body. The `runId` SHALL be the active pipeline run identifier (the run-directory slug or a per-process constant set at startup). The sentinel SHALL be invisible in rendered Markdown.

#### Scenario: Transition comment contains the sentinel
- **WHEN** `transition(cfg, issueNumber, "review-1", "fix-1", summary)` completes successfully
- **THEN** the posted comment body SHALL contain `<!-- pipeline-audit: run=<runId> state=fix-1 -->`
- **AND** the sentinel SHALL appear in the raw comment body returned by `getIssueDetail`

#### Scenario: Sentinel does not appear for silent transitions
- **WHEN** `silentTransition()` is called
- **THEN** no comment is posted and therefore no sentinel is written

### Requirement: Blocker comments SHALL embed an idempotency key
Every comment posted by `setBlocked()` SHALL include an HTML sentinel of the form `<!-- pipeline-audit: run=<runId> state=blocked -->` appended to the comment body.

#### Scenario: Blocker comment contains the sentinel
- **WHEN** `setBlocked(cfg, issueNumber, reason, stage, kind)` completes successfully
- **THEN** the posted comment body SHALL contain `<!-- pipeline-audit: run=<runId> state=blocked -->`

### Requirement: Comment posts SHALL be retried with backoff on transient failure
The comment-post step in `transition()` and `setBlocked()` SHALL be wrapped in an in-process retry loop that makes up to 3 attempts with exponential backoff (base 1 s, doubling per attempt) before propagating the error.

#### Scenario: Comment post succeeds on second attempt
- **WHEN** the first `postComment` call throws a transient error
- **AND** the second call succeeds
- **THEN** `transition()` or `setBlocked()` SHALL resolve without error
- **AND** exactly one comment SHALL have been posted (no partial duplicate from the failed first attempt)

#### Scenario: All retries exhausted
- **WHEN** all three `postComment` attempts throw
- **THEN** `transition()` or `setBlocked()` SHALL propagate the last error to the caller

### Requirement: The reconciler SHALL detect and repair a missing audit comment
At the start of each pipeline dispatch cycle, after the current stage is resolved from the issue's labels, the reconciler SHALL scan the issue's most-recent comments (up to 20) for an HTML sentinel whose `state` attribute matches the current label state. If no matching sentinel is found, the reconciler SHALL post a repair comment containing the sentinel and log a warning.

#### Scenario: Missing transition comment is repaired on next run
- **WHEN** an issue carries label `pipeline:fix-1`
- **AND** its comment history (last 20) contains no `<!-- pipeline-audit: ... state=fix-1 -->` sentinel
- **THEN** the reconciler SHALL post a repair comment containing `<!-- pipeline-audit: run=<currentRunId> state=fix-1 -->`
- **AND** the run log SHALL record a warning that a missing audit comment was repaired

#### Scenario: Missing blocked comment is repaired on next run
- **WHEN** an issue carries label `pipeline:blocked`
- **AND** its comment history (last 20) contains no `<!-- pipeline-audit: ... state=blocked -->` sentinel
- **THEN** the reconciler SHALL post a repair comment containing `<!-- pipeline-audit: run=<currentRunId> state=blocked -->`

#### Scenario: No repair when sentinel already present
- **WHEN** an issue's comment history contains `<!-- pipeline-audit: ... state=fix-1 -->`
- **AND** the current label is `pipeline:fix-1`
- **THEN** the reconciler SHALL NOT post any additional comment

### Requirement: Reconciler is idempotent across multiple runs
Calling the reconciler more than once on the same issue in the same or different runs SHALL NOT produce duplicate audit comments. The sentinel-presence check SHALL use a state-scoped substring match so that a marker written by any prior run prevents re-posting.

#### Scenario: Multiple runs see the same sentinel
- **WHEN** the reconciler is invoked twice in succession for the same issue and state
- **AND** the first invocation posted the repair comment
- **THEN** the second invocation SHALL detect the sentinel and skip posting
- **AND** no duplicate comment SHALL appear on the issue
