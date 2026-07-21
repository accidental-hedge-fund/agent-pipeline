# review-sha-gating Specification

## Purpose
TBD - created by archiving change key-review-verdicts-to-commit-sha. Update Purpose after archive.
## Requirements
### Requirement: Review comment embeds the evaluated commit SHA

When the pipeline posts a review comment for any review round, the comment SHALL include the HEAD commit SHA both as the individual HTML-comment sentinel `<!-- reviewed-sha: <full-sha> -->` on its own line (for backward compatibility) and inside the `ReviewArtifact` block (`reviewedSha` field) described in `review-artifact-record`. New comments SHALL carry both forms; old comments carry only the individual sentinel.

#### Scenario: Review comment is posted with SHA sentinel

- **WHEN** the pipeline posts a review comment (any round)
- **THEN** the comment body SHALL contain the line `<!-- reviewed-sha: <full-sha> -->` where `<full-sha>` is the full 40-character SHA of HEAD at review time
- **AND** the sentinel SHALL be present for both `approve` and `needs-attention` verdicts

#### Scenario: Review comment is posted with SHA in the ReviewArtifact block

- **WHEN** the pipeline posts a review comment (any round)
- **THEN** the `ReviewArtifact` block in the comment footer SHALL carry `reviewedSha` equal to the same 40-character SHA
- **AND** decoding the artifact SHALL confirm `artifact.reviewedSha === the reviewed-sha sentinel value`

#### Scenario: Short SHA is visible in comment header

- **WHEN** the pipeline posts a review comment
- **THEN** the comment header or footer SHALL display the first 7 characters of the SHA in human-readable form (e.g., `(commit abc1234)`)
- **AND** this short SHA SHALL be distinct from the hidden sentinel

---

### Requirement: Gate transition reads and validates the reviewed SHA

Before the pipeline acts on a prior review verdict (advancing from a review stage to the next gate), it SHALL extract the reviewed SHA using `extractReviewArtifact(body)?.reviewedSha` first; when `extractReviewArtifact` returns `null` it SHALL fall back to the `<!-- reviewed-sha: … -->` individual sentinel extractor. All subsequent gate logic (pipeline-internal-commits check, diff-hash cache comparison, blocking-keys re-evaluation) is unchanged: the source of the SHA is the only modification.

When the SHAs differ with non-pipeline-internal commits present, the gate SHALL additionally check the diff-hash cache before triggering any re-review. A SHA mismatch with an unchanged diff hash SHALL reuse the verdict; a SHA mismatch with a changed diff hash SHALL trigger a focused delta review rather than a full review-stage re-run. On EVERY verdict-reuse short-circuit — exact-SHA match, pipeline-internal-only commits since the review, or an unchanged diff hash — the gate SHALL treat the verdict as a valid approval only when the recorded review left no unresolved blocking findings: it SHALL re-evaluate the most recent review/delta comment's `pipeline-blocking-keys` marker against current overrides, and if any listed key remains un-overridden it SHALL keep the issue blocked at `pipeline:pre-merge` instead of reusing the verdict.

#### Scenario: SHA matches current HEAD with no unresolved blockers — verdict is trusted

- **WHEN** the gate transition reads the most recent review comment for round N
- **AND** the reviewed SHA (from artifact or fallback sentinel) matches the current HEAD SHA
- **AND** that comment records no blocking findings (no `pipeline-blocking-keys` marker, or an empty one), OR every recorded blocking key is currently overridden
- **THEN** the pipeline SHALL act on the verdict as normal and advance the gate transition

#### Scenario: SHA matches current HEAD but the recorded verdict still has unresolved blockers — gate holds

- **WHEN** the gate transition reads the most recent review comment for round N
- **AND** the reviewed SHA (from artifact or fallback sentinel) matches the current HEAD SHA
- **AND** that comment's `pipeline-blocking-keys` marker lists one or more keys that are NOT all currently overridden
- **THEN** the pipeline SHALL NOT treat the matching SHA as a valid approval and SHALL NOT advance toward ready-to-deploy
- **AND** SHALL keep the issue blocked at `pipeline:pre-merge` (`needs-human`) with a reason naming the unresolved blocking keys
- **AND** clearing the blocked label or overriding only some of the keys SHALL NOT resume the gate while any recorded blocking key remains un-overridden

#### Scenario: SHA does not match — pipeline-internal commits only — verdict is trusted

- **WHEN** the gate transition reads the most recent review comment for round N
- **AND** the reviewed SHA (from artifact or fallback sentinel) does NOT match the current HEAD SHA
- **AND** every commit since the reviewed SHA is a pipeline-internal commit
- **THEN** the prior verdict SHALL remain valid and the pipeline SHALL act on it as normal

#### Scenario: SHA does not match, non-internal commits present, diff hash unchanged — verdict reused

- **WHEN** the gate transition reads the most recent review comment for round N
- **AND** the reviewed SHA (from artifact or fallback sentinel) does NOT match the current HEAD SHA
- **AND** at least one non-pipeline-internal commit is present since the reviewed SHA
- **AND** the current PR diff hash matches the diff hash from the artifact or fallback sentinel in the prior review comment
- **AND** the prior review comment's `pipeline-blocking-keys` marker has no key, or every key is currently overridden
- **THEN** the pipeline SHALL treat the verdict as valid and SHALL NOT invoke the reviewer

#### Scenario: Legacy comment — SHA read from individual sentinel

- **WHEN** the gate reads a pre-migration review comment that carries no `ReviewArtifact` block
- **THEN** `extractReviewArtifact` SHALL return `null`
- **AND** the gate SHALL extract the SHA from the `<!-- reviewed-sha: … -->` sentinel
- **AND** all gate decisions SHALL proceed identically to the pre-migration path

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

### Requirement: The unresolved-blocking-keys gate SHALL ignore verdicts superseded by a newer developer commit

The pre-merge gate SHALL first establish that a recorded verdict is current before re-evaluating
that verdict's `pipeline-blocking-keys` marker against current overrides. A recorded
verdict is current when its `reviewed-sha` equals the PR branch head, or when every commit on the
PR since that `reviewed-sha` is pipeline-internal under the existing classification. A recorded
verdict whose `reviewed-sha` precedes a newer developer/fix commit on the PR is stale: the
pipeline SHALL NOT block pre-merge on its recorded blocking keys, and SHALL instead route to a
review of the current head.

This rule SHALL NOT alter the pipeline-internal-commit classification, and SHALL NOT weaken
blocking for current verdicts: an unresolved blocking key on a current verdict still holds the
gate, and clearing the blocked label or landing a no-op or OpenSpec-archive commit SHALL NOT
launder it.

#### Scenario: Stale recorded blockers do not block — re-review at the head

- **WHEN** the gate reads a recorded verdict whose `reviewed-sha` precedes a newer
  developer/fix commit on the PR
- **AND** that verdict records one or more un-overridden blocking keys
- **THEN** the gate SHALL NOT `setBlocked` the issue on those keys
- **AND** SHALL route to a review of the current head instead

#### Scenario: Verdict at the head with unresolved blockers still holds the gate

- **WHEN** the gate reads a recorded verdict whose `reviewed-sha` equals the current PR branch
  head
- **AND** that verdict records one or more un-overridden blocking keys
- **THEN** the gate SHALL keep the issue blocked at `pipeline:pre-merge` (`needs-human`) with a
  reason naming the unresolved keys, exactly as before this change

#### Scenario: Only pipeline-internal commits since the verdict — blockers still hold

- **WHEN** every commit on the PR since the recorded `reviewed-sha` is pipeline-internal
  (`chore: archive OpenSpec change(s) for #…`)
- **AND** that verdict records one or more un-overridden blocking keys
- **THEN** the verdict SHALL be treated as current
- **AND** the gate SHALL keep the issue blocked on those keys — a no-op or archive commit SHALL
  NOT bypass the gate

#### Scenario: Staleness is judged by PR commit order, not comment order

- **WHEN** the gate evaluates whether a recorded verdict is stale
- **THEN** it SHALL decide using the PR's commit list and the pipeline-internal classification
- **AND** SHALL NOT rely on comment timestamps or comment ordering to establish currency

