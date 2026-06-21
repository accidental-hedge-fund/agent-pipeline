## MODIFIED Requirements

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
