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

### Requirement: The unresolved-blocking-keys gate SHALL ignore verdicts superseded by a newer developer commit

The pre-merge gate SHALL first establish that a recorded verdict is current before re-evaluating
that verdict's `pipeline-blocking-keys` marker against current overrides. A recorded
verdict is current when its `reviewed-sha` equals the PR branch head, or when every commit on the
PR since that `reviewed-sha` is pipeline-internal under the existing classification **and** the
verdict left no unresolved residual blocking keys that still require live-head re-evaluation
(see residual SHA-scope below). A recorded
verdict whose `reviewed-sha` precedes a newer developer/fix commit on the PR is stale: the
pipeline SHALL NOT block pre-merge on its recorded blocking keys, and SHALL instead route to a
review of the current head.

**Residual SHA-scope (#1010):** when a recorded verdict still has un-overridden residual
`pipeline-blocking-keys` and the marker’s reviewed SHA differs from the live open PR head,
those keys lack residual blocking authority for the live head even if every commit since the
reviewed SHA is pipeline-internal. The gate SHALL NOT `setBlocked` solely from that prior-head
key set; it SHALL re-enter delta evaluation or the existing conservative re-review path at the
live head. Pipeline-internal classification for **approval** reuse (no residual keys) is
unchanged: archive / visual-publish commits alone still do not invalidate a clean approval.

This rule SHALL NOT alter the pipeline-internal-commit classification for approval reuse, and
SHALL NOT weaken blocking for current same-head verdicts: an unresolved blocking key on a
verdict whose reviewed SHA equals the live head still holds the gate, and clearing the blocked
label or landing a no-op or OpenSpec-archive commit SHALL NOT silent-approve past residual keys
without live-head re-evaluation when the reviewed SHA and live head differ.

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
  (`chore: archive OpenSpec change(s) for #…` or exact visual-publish subject)
- **AND** that verdict records one or more un-overridden blocking keys
- **AND** the recorded `reviewed-sha` differs from the live open PR head
- **THEN** the gate SHALL NOT silent-approve or launder those residual keys via the archive tip advance
- **AND** SHALL NOT `setBlocked` solely from the prior-head residual key set without live-head re-evaluation
- **AND** SHALL re-enter delta evaluation or conservative re-review at the live head so residual
  findings are re-asserted or cleared at the live head (blockers still hold when re-asserted)

#### Scenario: Staleness is judged by PR commit order, not comment order

- **WHEN** the gate evaluates whether a recorded verdict is stale
- **THEN** it SHALL decide using the PR's commit list and the pipeline-internal classification
- **AND** SHALL NOT rely on comment timestamps or comment ordering to establish currency

### Requirement: Pipeline-internal commit exemption uses the neutral classifier set

When the SHA gate detects that HEAD has moved past the reviewed commit, it SHALL classify commits since the review as either "pipeline-internal" or "developer/fix" using `isPipelineInternalCommit` from the neutral pipeline-commits module. A commit is pipeline-internal if and only if that classifier returns true for its message headline: the OpenSpec archive prefix (`chore: archive OpenSpec change(s) for #…`) or the exact visual-gate artifact-publish subject (`chore: publish visual-gate evidence for #<digits>` with no trailing text). If every commit since the review is pipeline-internal, the prior verdict SHALL remain valid without any further checks for the internal-commit exemption path. A docs-update commit (`docs: update documentation for #`) SHALL NOT be treated as pipeline-internal. An auto-format commit (`chore: auto-format (#…`) SHALL NOT be treated as pipeline-internal. A pre-merge auto-fix commit SHALL NOT be treated as pipeline-internal. When non-pipeline-internal commits are present, the gate SHALL continue to the diff-hash cache check (not immediately trigger a review stage re-run).

#### Scenario: Only OpenSpec archive commits since review — verdict valid

- **WHEN** HEAD has moved past the reviewed SHA
- **AND** every commit since the review has the message prefix `chore: archive OpenSpec change(s) for #`
- **THEN** the SHA gate SHALL treat the prior verdict as valid for the internal-commit exemption and SHALL NOT trigger a re-review or diff-hash check solely because those archive commits landed

#### Scenario: Only exact visual-publish commits since review — verdict valid

- **WHEN** HEAD has moved past the reviewed SHA
- **AND** every commit since the review is an exact visual-gate artifact-publish subject
- **THEN** the SHA gate SHALL treat the prior verdict as valid for the internal-commit exemption
- **AND** SHALL NOT invalidate the verdict solely because those publish commits landed

#### Scenario: A docs-prefix commit present — treated as developer commit

- **WHEN** a commit with message prefix `docs: update documentation for #` is present since the review
- **THEN** the SHA gate SHALL treat that commit as a developer commit
- **AND** SHALL proceed to the diff-hash cache check (not immediately trigger re-review)

#### Scenario: An auto-format commit present — treated as developer commit

- **WHEN** a commit with message beginning `chore: auto-format (#` is present since the review
- **THEN** the SHA gate SHALL treat that commit as a developer commit
- **AND** SHALL proceed to the diff-hash cache check

#### Scenario: Mix of archive and developer commits — diff-hash check required

- **WHEN** commits since the review include at least one commit that is not pipeline-internal under the neutral classifier
- **THEN** the SHA gate SHALL NOT immediately trigger a full review re-run
- **AND** SHALL proceed to the diff-hash cache check; if the diff hash is unchanged, the verdict is reused; if the diff hash changed, a delta review runs

### Requirement: Review-SHA gate decisions SHALL consume review-currency reconcile outputs

Before the pipeline acts on a prior review verdict, it SHALL obtain reuse / re-review / hold
disposition from the review-verdict currency reconcile surface (or a thin wrapper that implements
the same rules). Product rules for exact-SHA match, pipeline-internal-only commits, diff-hash reuse,
delta vs full re-review, and unresolved blocking-key holds remain as already specified; this
requirement consolidates decision authority into reconcile rather than stage-local terminalization
side paths.

#### Scenario: SHA-match approval still requires resolved blockers

- **WHEN** review-currency reconcile observes reviewed SHA matching HEAD
- **AND** unresolved blocking keys remain
- **THEN** the gate SHALL NOT advance as if approved
- **AND** SHALL hold at pre-merge for those keys without inventing human-decision authority

#### Scenario: Recurrence or ceiling counts are inputs not independent human holds

- **WHEN** finding recurrence or ceiling evidence is available at gate time
- **THEN** that evidence SHALL feed reconcile / recovery routing
- **AND** SHALL NOT alone apply `pipeline:needs-human` without current
  `human-decision-required` authority evidence

### Requirement: Candidate-integrity scope expansion SHALL invalidate prior review as readiness authority

The review-SHA gate and readiness paths that consume review evidence SHALL treat prior review verdicts for the pre-mutation candidate as not sufficient authority for the post-mutation head when candidate-integrity classifies a pipeline-owned mutation as `scope_expansion` or `unverified`. This invalidation SHALL apply even if residual identity heuristics might otherwise look reusable. Exact-SHA match and pipeline-internal-only exemptions on an unchanged head remain unchanged; this requirement applies to classified candidate-moving mutations and unverified transitions, not to ordinary no-movement cases.

#### Scenario: Scope expansion blocks verdict reuse for readiness

- **WHEN** candidate-integrity reports `scope_expansion` for a mutation from SHA `A` to SHA `B`
- **AND** the most recent approve verdict was recorded against SHA `A` or its pre-mutation surface
- **THEN** the gate SHALL NOT treat that verdict as readiness authority for SHA `B`
- **AND** SHALL require review (or the existing delta-review path when applicable) of the current head before further readiness progress

#### Scenario: Unverified mutation blocks verdict reuse

- **WHEN** candidate-integrity reports `unverified` for a claimed head movement
- **THEN** the gate SHALL NOT reuse pre-mutation review evidence for ready-to-deploy on the unconfirmed head

#### Scenario: Semantic equivalence does not invent a free pass past unresolved blockers

- **WHEN** candidate-integrity reports `semantically_equivalent`
- **AND** the current review evidence still carries unresolved blocking keys under existing gate rules
- **THEN** those unresolved blockers SHALL still hold the gate
- **AND** semantic equivalence SHALL NOT clear blocking keys

