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

Before the pipeline acts on a prior review verdict (advancing from a review stage to the next gate), it SHALL extract the `reviewed-sha` sentinel from the most recent review comment for that round and compare it to the current HEAD commit SHA. When the SHAs differ with non-pipeline-internal commits present, the gate SHALL additionally check the diff-hash cache (`verdict-diff-hash` sentinel) before triggering any re-review. A SHA mismatch with an unchanged diff hash SHALL reuse the verdict; a SHA mismatch with a changed diff hash SHALL trigger a focused delta review rather than a full review-stage re-run. On EVERY verdict-reuse short-circuit — exact-SHA match, pipeline-internal-only commits since the review, or an unchanged diff hash — the gate SHALL treat the verdict as a valid approval only when the recorded review left no unresolved blocking findings: it SHALL re-evaluate the most recent review/delta comment's `pipeline-blocking-keys` marker against current overrides, and if any listed key remains un-overridden it SHALL keep the issue blocked at `pipeline:pre-merge` instead of reusing the verdict.

#### Scenario: SHA matches current HEAD with no unresolved blockers — verdict is trusted

- **WHEN** the gate transition reads the most recent review comment for round N
- **AND** the `reviewed-sha` sentinel in that comment matches the current HEAD SHA
- **AND** that comment records no blocking findings (no `pipeline-blocking-keys` marker, or an empty one), OR every recorded blocking key is currently overridden
- **THEN** the pipeline SHALL act on the verdict as normal and advance the gate transition

#### Scenario: SHA matches current HEAD but the recorded verdict still has unresolved blockers — gate holds

- **WHEN** the gate transition reads the most recent review comment for round N
- **AND** the `reviewed-sha` sentinel in that comment matches the current HEAD SHA
- **AND** that comment's `pipeline-blocking-keys` marker lists one or more keys that are NOT all currently overridden
- **THEN** the pipeline SHALL NOT treat the matching SHA as a valid approval and SHALL NOT advance toward ready-to-deploy
- **AND** SHALL keep the issue blocked at `pipeline:pre-merge` (`needs-human`) with a reason naming the unresolved blocking keys
- **AND** clearing the blocked label or overriding only some of the keys SHALL NOT resume the gate while any recorded blocking key remains un-overridden

This closes a bypass introduced with the pre-merge delta review: a blocking delta review posts its comment carrying `reviewed-sha == HEAD` and then blocks at `pipeline:pre-merge`, so a matching-SHA short-circuit that did not re-evaluate the recorded blocking keys could resume and advance with unresolved blocking findings.

#### Scenario: SHA does not match — pipeline-internal commits only — verdict is trusted

- **WHEN** the gate transition reads the most recent review comment for round N
- **AND** the `reviewed-sha` sentinel does NOT match the current HEAD SHA
- **AND** every commit since the reviewed SHA is a pipeline-internal commit
- **THEN** the prior verdict SHALL remain valid and the pipeline SHALL act on it as normal

#### Scenario: SHA does not match, non-internal commits present, diff hash unchanged — verdict reused

- **WHEN** the gate transition reads the most recent review comment for round N
- **AND** the `reviewed-sha` sentinel does NOT match the current HEAD SHA
- **AND** at least one non-pipeline-internal commit is present since the reviewed SHA
- **AND** the current PR diff hash matches the `verdict-diff-hash` sentinel in the prior review comment
- **AND** the prior review comment's `pipeline-blocking-keys` marker has no key, or every key is currently overridden
- **THEN** the pipeline SHALL treat the verdict as valid and SHALL NOT invoke the reviewer
- **AND** SHALL post a brief notice: "Diff unchanged since last review; verdict reused."
- **AND** SHALL NOT route the issue to a review stage

#### Scenario: Diff hash unchanged but recorded blockers remain — gate holds (no-op-commit bypass closed)

- **WHEN** the gate transition reads the most recent review comment for round N
- **AND** the `reviewed-sha` sentinel does NOT match HEAD (e.g. a no-op commit moved HEAD)
- **AND** the current PR diff hash matches the `verdict-diff-hash` sentinel in that comment
- **AND** that comment's `pipeline-blocking-keys` marker lists one or more keys that are NOT all currently overridden
- **THEN** the pipeline SHALL keep the issue blocked at `pipeline:pre-merge` (`needs-human`) and SHALL NOT reuse the verdict, post the reuse notice, or advance

#### Scenario: SHA does not match, diff hash changed — delta review runs (not full re-review)

- **WHEN** the gate transition reads the most recent review comment for round N
- **AND** the `reviewed-sha` sentinel does NOT match the current HEAD SHA
- **AND** at least one non-pipeline-internal commit is present since the reviewed SHA
- **AND** the current PR diff hash does NOT match the `verdict-diff-hash` sentinel (or no sentinel is present)
- **THEN** the pipeline SHALL NOT route the issue back to the review-N stage
- **AND** SHALL run a focused adversarial delta review of `last-reviewed-sha...HEAD`
- **AND** SHALL post a delta-review comment embedding updated `reviewed-sha` and `verdict-diff-hash` sentinels
- **AND** on delta-review approve: SHALL proceed with the gate transition as normal
- **AND** on delta-review blocking findings: SHALL block with reason "Pre-merge delta review found blocking findings; fix required before merging."

#### Scenario: Review comment has no SHA sentinel — treated as stale

- **WHEN** the gate transition reads the most recent review comment for round N
- **AND** the comment contains no `<!-- reviewed-sha: ... -->` sentinel
- **THEN** the pipeline SHALL treat the verdict as unverifiable and SHALL run the review stage normally (same as before this change)
- **AND** SHALL NOT advance or block based on the unverified verdict

#### Scenario: No prior review comment exists — normal first-run review

- **WHEN** the gate transition finds no prior review comment for round N
- **THEN** the pipeline SHALL run review as normal (no stale-check needed)
- **AND** the new review comment SHALL include both the `reviewed-sha` and `verdict-diff-hash` sentinels

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

When the SHA gate detects that HEAD has moved past the reviewed commit, it SHALL classify commits since the review as either "pipeline-internal" or "developer/fix". A commit is pipeline-internal if and only if its message headline starts with the OpenSpec archive prefix (`chore: archive OpenSpec change(s) for #`). If every commit since the review is pipeline-internal, the prior verdict SHALL remain valid without any further checks. A docs-update commit (`docs: update documentation for #`) SHALL NOT be treated as pipeline-internal, because the pre-merge docs step no longer exists and no such commits are produced by the pipeline. When non-pipeline-internal commits are present, the gate SHALL continue to the diff-hash cache check (not immediately trigger a review stage re-run).

#### Scenario: Only OpenSpec archive commits since review — verdict valid

- **WHEN** HEAD has moved past the reviewed SHA
- **AND** every commit since the review has the message prefix `chore: archive OpenSpec change(s) for #`
- **THEN** the SHA gate SHALL treat the prior verdict as valid and SHALL NOT trigger a re-review or diff-hash check

#### Scenario: A docs-prefix commit present — treated as developer commit

- **WHEN** a commit with message prefix `docs: update documentation for #` is present since the review
- **THEN** the SHA gate SHALL treat that commit as a developer commit
- **AND** SHALL proceed to the diff-hash cache check (not immediately trigger re-review)

#### Scenario: Mix of archive and developer commits — diff-hash check required

- **WHEN** commits since the review include at least one commit that is not an OpenSpec archive commit
- **THEN** the SHA gate SHALL NOT immediately trigger a full review re-run
- **AND** SHALL proceed to the diff-hash cache check; if the diff hash is unchanged, the verdict is reused; if the diff hash changed, a delta review runs

