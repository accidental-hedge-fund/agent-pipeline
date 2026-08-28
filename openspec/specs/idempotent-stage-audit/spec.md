# idempotent-stage-audit Specification

## Purpose
TBD - created by archiving change idempotent-stage-audit. Update Purpose after archive.

## Requirements

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
At the start of each pipeline dispatch cycle, after the current stage is resolved from the issue's labels, the reconciler SHALL scan the issue's most-recent comments (up to 20) for a trusted HTML sentinel whose `state` attribute matches the current label state. A sentinel is trusted only when its comment is authored by the pipeline's authenticated GitHub actor or by an identity listed in `trusted_audit_actors`, AND the comment body is a pipeline audit comment (starts with `## Pipeline:` and contains `<!-- pipeline-audit:`). If the actor is resolved and no trusted matching sentinel is found, the reconciler SHALL post a repair comment containing the sentinel and log a warning. If the actor is not resolved, the reconciler SHALL NOT post a repair (see the unresolved-actor requirement). This requirement SHALL NOT widen the 20-comment recency window.

#### Scenario: Missing transition comment is repaired on next run
- **WHEN** an issue carries label `pipeline:fix-1`
- **AND** the pipeline's GitHub actor is resolved
- **AND** its comment history (last 20) contains no trusted `<!-- pipeline-audit: ... state=fix-1 -->` sentinel
- **THEN** the reconciler SHALL post a repair comment containing `<!-- pipeline-audit: run=<currentRunId> state=fix-1 -->`
- **AND** the run log SHALL record a warning that a missing audit comment was repaired

#### Scenario: Missing blocked comment is repaired on next run
- **WHEN** an issue carries label `pipeline:blocked`
- **AND** the pipeline's GitHub actor is resolved
- **AND** its comment history (last 20) contains no trusted `<!-- pipeline-audit: ... state=blocked -->` sentinel
- **THEN** the reconciler SHALL post a repair comment containing `<!-- pipeline-audit: run=<currentRunId> state=blocked -->`

#### Scenario: No repair when sentinel already present
- **WHEN** an issue's comment history contains `<!-- pipeline-audit: ... state=fix-1 -->` on a `## Pipeline:` comment
- **AND** that comment is authored by the pipeline's authenticated GitHub actor
- **AND** the current label is `pipeline:fix-1`
- **THEN** the reconciler SHALL NOT post any additional comment

### Requirement: Reconciler is idempotent across multiple runs
Calling the reconciler more than once on the same issue in the same or different runs SHALL NOT produce duplicate audit comments when a trusted sentinel for that state is already present. The sentinel-presence check SHALL use a state-scoped substring match plus trusted authorship so that a marker written by the current actor, or by an identity in `trusted_audit_actors`, in any prior run prevents re-posting. A marker written by an untrusted author SHALL NOT prevent re-posting.

#### Scenario: Multiple runs see the same sentinel
- **WHEN** the reconciler is invoked twice in succession for the same issue and state
- **AND** the GitHub actor is resolved on both invocations
- **AND** the first invocation posted the repair comment under a trusted author
- **THEN** the second invocation SHALL detect the trusted sentinel and skip posting
- **AND** no duplicate comment SHALL appear on the issue

### Requirement: The reconciler SHALL NOT post a repair when the GitHub actor is unresolved
The reconciler SHALL NOT post an audit-repair comment when the pipeline cannot resolve its authenticated GitHub actor. The reconciler SHALL emit visible run evidence that names the skip reason (actor unresolved) and SHALL NOT claim that a repair was posted. The dispatch SHALL continue. A later invocation that can resolve the actor SHALL still post a repair when a trusted matching sentinel is absent.

#### Scenario: Unresolved actor skips repair even when no sentinel is visible
- **WHEN** the pipeline cannot resolve its GitHub actor
- **AND** the current label is `pipeline:fix-1`
- **AND** the last 20 comments contain no trusted `state=fix-1` sentinel
- **THEN** the reconciler SHALL NOT post a repair comment
- **AND** the run log SHALL record a warning that names the unresolved-actor skip
- **AND** that warning SHALL NOT say that a repair is being posted

#### Scenario: Unresolved actor does not treat existing pipeline comments as a gap to fill
- **WHEN** the pipeline cannot resolve its GitHub actor
- **AND** the last 20 comments already contain a `## Pipeline:` body with `<!-- pipeline-audit: ... state=fix-1 -->` authored by a pipeline host
- **THEN** the reconciler SHALL NOT post a repair comment

#### Scenario: Later resolved invocation still repairs a true gap
- **WHEN** a prior invocation skipped repair because the actor was unresolved
- **AND** a later invocation resolves the GitHub actor
- **AND** the current label is `pipeline:fix-1`
- **AND** the last 20 comments still contain no trusted matching sentinel
- **THEN** the reconciler SHALL post a repair comment containing `<!-- pipeline-audit: run=<currentRunId> state=fix-1 -->`

### Requirement: Audit-sentinel trust SHALL use the current actor plus trusted_audit_actors only
The reconciler SHALL treat a matching audit sentinel as trusted when the comment author equals the pipeline's authenticated GitHub actor or an identity listed in the optional config key `trusted_audit_actors`. Absent or empty `trusted_audit_actors` SHALL mean only the current actor is trusted. The reconciler SHALL NOT treat `trusted_override_actors` as audit-sentinel trust. An arbitrary commenter SHALL NOT suppress audit repair by forging a `## Pipeline:` heading and sentinel. A comment whose author is missing SHALL NOT be trusted.

#### Scenario: Allowlisted pipeline host sentinel suppresses repair
- **WHEN** the current actor is `codex-bot`
- **AND** `trusted_audit_actors` contains `claude-bot`
- **AND** the last 20 comments contain a `## Pipeline:` body with `<!-- pipeline-audit: ... state=fix-1 -->` authored by `claude-bot`
- **AND** the current label is `pipeline:fix-1`
- **THEN** the reconciler SHALL NOT post a repair comment

#### Scenario: Override allowlist does not grant audit-sentinel trust
- **WHEN** the current actor is `codex-bot`
- **AND** `trusted_override_actors` contains `claude-bot`
- **AND** `trusted_audit_actors` is absent or does not contain `claude-bot`
- **AND** the last 20 comments contain a matching `state=fix-1` sentinel authored by `claude-bot`
- **AND** the current label is `pipeline:fix-1`
- **THEN** the reconciler SHALL post a repair comment

#### Scenario: Forged pipeline sentinel does not suppress repair
- **WHEN** the current actor is resolved as `pipeline-bot`
- **AND** the last 20 comments contain a `## Pipeline:` body with `<!-- pipeline-audit: ... state=fix-1 -->` authored by `attacker`
- **AND** `attacker` is not in `trusted_audit_actors`
- **AND** the current label is `pipeline:fix-1`
- **THEN** the reconciler SHALL post a repair comment

#### Scenario: Quoted sentinel in a non-pipeline comment does not suppress repair
- **WHEN** the current actor is resolved
- **AND** the last 20 comments contain a human comment that quotes `<!-- pipeline-audit: ... state=fix-1 -->` but does not start with `## Pipeline:`
- **AND** the current label is `pipeline:fix-1`
- **THEN** the reconciler SHALL post a repair comment
