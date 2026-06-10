# review-sha-gating Specification

## Purpose
TBD - created by archiving change key-review-verdicts-to-commit-sha. Update Purpose after archive.
## Requirements
### Requirement: Review comment embeds the evaluated commit SHA

When the pipeline posts a review comment for any review round, the comment SHALL include the HEAD commit SHA that was current at the time the review ran, embedded as an HTML comment sentinel on its own line: `<!-- reviewed-sha: <full-sha> -->`.

#### Scenario: Review comment is posted with SHA sentinel

- **WHEN** the pipeline posts a review comment (any round)
- **THEN** the comment body SHALL contain the line `<!-- reviewed-sha: <full-sha> -->` where `<full-sha>` is the full 40-character SHA of HEAD at review time
- **AND** the sentinel SHALL be present for both `approve` and `needs-attention` verdicts

#### Scenario: Short SHA is visible in comment header

- **WHEN** the pipeline posts a review comment
- **THEN** the comment header or footer SHALL display the first 7 characters of the SHA in human-readable form (e.g., `(commit abc1234)`)
- **AND** this short SHA SHALL be distinct from the hidden sentinel

---

### Requirement: Gate transition reads and validates the reviewed SHA

Before the pipeline acts on a prior review verdict (advancing from a review stage to the next gate), it SHALL extract the `reviewed-sha` sentinel from the most recent review comment for that round and compare it to the current HEAD commit SHA.

#### Scenario: SHA matches current HEAD — verdict is trusted

- **WHEN** the gate transition reads the most recent review comment for round N
- **AND** the `reviewed-sha` sentinel in that comment matches the current HEAD SHA
- **THEN** the pipeline SHALL act on the verdict as normal (approve advances; needs-attention routes to fix)

#### Scenario: SHA does not match current HEAD — verdict is discarded and review re-runs

- **WHEN** the gate transition reads the most recent review comment for round N
- **AND** the `reviewed-sha` sentinel in that comment does NOT match the current HEAD SHA
- **THEN** the pipeline SHALL discard the prior verdict
- **AND** SHALL re-invoke the review stage for round N against the current HEAD
- **AND** SHALL post a new review comment recording the new SHA
- **AND** SHALL NOT advance or block based on the stale verdict

#### Scenario: Review comment has no SHA sentinel — treated as stale

- **WHEN** the gate transition reads the most recent review comment for round N
- **AND** the comment contains no `<!-- reviewed-sha: ... -->` sentinel
- **THEN** the pipeline SHALL treat the verdict as unverifiable and re-run review
- **AND** SHALL NOT advance or block based on the unverified verdict

#### Scenario: No prior review comment exists — normal first-run review

- **WHEN** the gate transition finds no prior review comment for round N
- **THEN** the pipeline SHALL run review as normal (no stale-check needed)
- **AND** the new review comment SHALL include the SHA sentinel

---

### Requirement: Re-review due to SHA mismatch is visible on the PR

When a review is re-run because HEAD advanced past the reviewed SHA, the pipeline SHALL post a brief notice comment before re-running, identifying the stale SHA and the new HEAD SHA.

#### Scenario: Stale-verdict notice is posted before re-review

- **WHEN** a SHA mismatch is detected before acting on a prior verdict
- **THEN** the pipeline SHALL post a comment of the form: `Re-running review: HEAD has moved from <old-short-sha> to <new-short-sha> since the last review.`
- **AND** this notice SHALL be posted before the new review comment

---

### Requirement: SHA check does not alter no-movement behavior

When HEAD has not changed since the last review, the pipeline behavior SHALL be identical to behavior before this change — no additional latency, no extra API calls beyond reading the existing review comment.

#### Scenario: HEAD unchanged — pipeline is transparent

- **WHEN** the gate transition detects SHA match
- **THEN** no additional GitHub API calls beyond reading the existing comment SHALL be made
- **AND** the verdict routing logic SHALL execute as if no SHA check occurred

### Requirement: Pipeline-internal commit exemption covers only OpenSpec archive commits
When the SHA gate detects that HEAD has moved past the reviewed commit, it SHALL classify commits since the review as either "pipeline-internal" or "developer/fix". A commit is pipeline-internal if and only if its message headline starts with the OpenSpec archive prefix (`chore: archive OpenSpec change(s) for #`). If every commit since the review is pipeline-internal, the prior verdict SHALL remain valid. A docs-update commit (`docs: update documentation for #`) SHALL NOT be treated as pipeline-internal, because the pre-merge docs step no longer exists and no such commits are produced by the pipeline.

#### Scenario: Only OpenSpec archive commits since review — verdict valid
- **WHEN** HEAD has moved past the reviewed SHA
- **AND** every commit since the review has the message prefix `chore: archive OpenSpec change(s) for #`
- **THEN** the SHA gate SHALL treat the prior verdict as valid and SHALL NOT trigger a re-review

#### Scenario: A docs-prefix commit present — treated as developer commit
- **WHEN** a commit with message prefix `docs: update documentation for #` is present since the review
- **THEN** the SHA gate SHALL treat that commit as a developer commit
- **AND** SHALL trigger re-review as if HEAD had moved past the reviewed SHA

#### Scenario: Mix of archive and developer commits — re-review required
- **WHEN** commits since the review include at least one commit that is not an OpenSpec archive commit
- **THEN** the SHA gate SHALL discard the prior verdict and re-run review

