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

### Requirement: Enter-path stale-block resume SHALL use the same supersession classification as the SHA gate

When the pipeline decides whether a leftover `pipeline:blocked` label is stale because PR HEAD moved past the blocking `reviewed-sha`, it SHALL use the same non-pipeline-internal supersession classification that the pre-merge review-SHA gate uses to decide whether a recorded verdict is current, superseded, or unclassifiable. Pipeline-internal-only tip advances SHALL remain non-invalidating for clean approval reuse (#98). A residual same-head blocking key set SHALL continue to hold the gate when `reviewed-sha` equals the live head. This requirement does not invent overrides and does not weaken security residual blocking on a current head.

#### Scenario: Shared supersession definition for resume and gate

- **WHEN** enter-path stale-block resume classifies commits between blocking `reviewed-sha` S and PR HEAD H
- **THEN** it SHALL treat non-pipeline-internal commits as superseding the blocking verdict under the same rules as the pre-merge SHA gate
- **AND** SHALL treat pipeline-internal-only ranges as non-superseding for verdict-reuse purposes (#98)

#### Scenario: Same-head residual keys still hold

- **WHEN** the live PR head equals the blocking `reviewed-sha` and residual blocking keys remain un-overridden
- **THEN** the SHA gate and enter-path resume SHALL both keep residual authority at that head
- **AND** SHALL NOT clear the block solely as a stale resume

### Requirement: Later-stage dispatch SHALL reconcile review currency before the later stage runs

The pipeline SHALL, before dispatching `visual-gate`, `eval-gate`, `shipcheck-gate`, or `ready-to-deploy`, reconcile the linked PR HEAD against the latest authoritative review evidence using the same non-pipeline-internal supersession classification that the pre-merge review-SHA gate uses. The pipeline SHALL obtain that classification from the existing review-currency reconcile surface. It SHALL NOT invent a later-stage-local reuse rule. Pre-merge SHALL keep its existing in-stage SHA gate, including pipeline-internal reuse and delta review while the issue remains at `pre-merge`.

The latest authoritative review evidence SHALL be the most recent review or delta-review `reviewed-sha` (artifact first, individual sentinel fallback) that the SHA gate already trusts. The pipeline SHALL resolve the authenticated pipeline actor and SHALL pass only comments authored by that actor to reviewed-SHA extraction. When the actor cannot be determined, the pipeline SHALL fail closed: it SHALL NOT dispatch the later stage. When that SHA is current under exact match or pipeline-internal-only commits, the pipeline SHALL dispatch the later stage. Exact-SHA current SHALL be the shared currency resolver's final observed HEAD, not a first HEAD read that skipped reconcile. When that SHA is superseded by at least one non-pipeline-internal commit, or when HEAD is readable, differs from the reviewed SHA, and currency cannot prove pipeline-internal-only reuse, the pipeline SHALL treat the movement as a new candidate epoch: it SHALL invalidate candidate-bound review, test, and readiness evidence for the prior SHA as authority for the new HEAD; clear a leftover `pipeline:blocked` label; bind a present managed worktree to the new HEAD (or fail closed when no managed worktree is on disk, rather than reviewing from `cfg.repo_dir`); re-read the authoritative PR HEAD after bind and restart reconciliation when that HEAD has moved; transition in the same advance to the first enabled exact-SHA review stage (`review-1`, otherwise `review-2`); durably record the epoch restart with the old and new SHAs and stages; and require a review bound to the new HEAD before any later-stage handler or ready-to-deploy finalize runs. Review SHALL fail closed when its captured PR SHA differs from the review CWD HEAD. If neither exact-SHA review stage is enabled, the pipeline SHALL fail closed. When the linked PR or HEAD cannot be read, the pipeline SHALL fail closed: it SHALL NOT dispatch the later stage and SHALL NOT reach `pipeline:ready-to-deploy`.

This guard SHALL apply to ordinary advance, nested whole-item advance, `pipeline single`, and durable loop item recovery. A leftover `pipeline:blocked` label SHALL NOT be required for the guard to run.

Ready-to-deploy SHALL run this guard immediately before terminal finalization, including the deferred finalizer used after the iteration budget is exhausted. An earlier guard observation in the same run SHALL NOT authorize a later finalizer after HEAD moves.

#### Scenario: Visual-gate resume after developer HEAD movement returns to review-1

- **WHEN** the current stage is `visual-gate` and the issue is not blocked
- **AND** the latest review `reviewed-sha` is S
- **AND** the linked PR HEAD H is a descendant of S with at least one non-pipeline-internal commit in S..H
- **THEN** the pipeline SHALL NOT run the visual-gate handler
- **AND** SHALL NOT transition to `eval-gate`, `shipcheck-gate`, or `ready-to-deploy` on this head
- **AND** SHALL atomically transition the issue to `review-1` in the same advance invocation
- **AND** SHALL require a review whose recorded SHA is H

#### Scenario: Eval-gate, shipcheck-gate, and ready-to-deploy share the same guard

- **WHEN** the current stage is `eval-gate`, `shipcheck-gate`, or `ready-to-deploy`
- **AND** PR HEAD has moved past the latest review SHA with a non-pipeline-internal commit
- **THEN** the pipeline SHALL NOT run that later-stage handler or ready-to-deploy finalize
- **AND** SHALL transition the issue to the first enabled exact-SHA review stage before that later work runs

#### Scenario: Deferred ready-to-deploy finalizer rechecks currency

- **WHEN** earlier later-gate checks observed current review currency
- **AND** the iteration budget defers ready-to-deploy finalization
- **AND** PR HEAD moves past the reviewed SHA before the deferred finalizer
- **THEN** the finalizer SHALL re-run review-currency reconciliation
- **AND** SHALL NOT finalize or preserve ready-to-deploy authority for the stale candidate

#### Scenario: Leftover block is cleared for the new candidate epoch

- **WHEN** a later-stage issue still carries `pipeline:blocked`
- **AND** authenticated review evidence at S is superseded by non-pipeline-internal HEAD H
- **THEN** the pipeline SHALL clear the leftover block before transitioning to the enabled review stage
- **AND** SHALL durably record one candidate-epoch restart from S to H

#### Scenario: No enabled exact-SHA review stage fails closed

- **WHEN** later-stage review currency is superseded
- **AND** both standard and adversarial review stages are disabled
- **THEN** the pipeline SHALL fail closed without dispatching or finalizing the later stage

#### Scenario: Pipeline-internal-only commits keep later-stage reuse

- **WHEN** the current stage is `visual-gate`, `eval-gate`, `shipcheck-gate`, or `ready-to-deploy`
- **AND** every commit since the latest review SHA is pipeline-internal under the existing classifier
- **THEN** the pipeline SHALL treat review currency as current
- **AND** SHALL dispatch the later stage
- **AND** SHALL NOT force re-review solely because those internal commits landed

#### Scenario: Unreadable HEAD fails closed

- **WHEN** the pipeline cannot resolve the linked open PR or cannot read PR HEAD during later-stage dispatch reconcile
- **THEN** the pipeline SHALL NOT dispatch the later stage
- **AND** SHALL NOT reach `pipeline:ready-to-deploy`
- **AND** SHALL NOT treat missing observation as current review currency

#### Scenario: Nested, single, and loop resume share the guard

- **WHEN** nested whole-item advance, `pipeline single`, durable loop recovery, or ordinary advance enters a later stage
- **THEN** the pipeline SHALL run the same review-currency reconcile before that later stage
- **AND** SHALL NOT require a leftover `pipeline:blocked` label for the reconcile to run

#### Scenario: Exact-SHA review is required after the epoch change

- **WHEN** later-stage dispatch returns the issue to `review-1` because HEAD H superseded review SHA S
- **THEN** the subsequent review SHALL evaluate H
- **AND** SHALL record `reviewed-sha` H
- **AND** SHALL NOT reuse the S verdict as approval for H

#### Scenario: Missing managed worktree fails closed before epoch-restarted review

- **WHEN** later-stage dispatch would return the issue to `review-1` because HEAD H superseded review SHA S
- **AND** no managed worktree is on disk
- **THEN** the pipeline SHALL fail closed
- **AND** SHALL NOT dispatch review from `cfg.repo_dir`
- **AND** SHALL NOT transition to `review-1`

#### Scenario: PR HEAD movement during epoch-restart bind restarts reconcile

- **WHEN** later-stage bind targets HEAD H
- **AND** the linked PR HEAD becomes J before review dispatch
- **THEN** the pipeline SHALL NOT review J from a checkout at H
- **AND** SHALL restart review-currency reconciliation against J

#### Scenario: Review fails closed when CWD HEAD differs from captured PR SHA

- **WHEN** review captures linked PR HEAD H
- **AND** the review CWD HEAD is a different full SHA
- **THEN** the pipeline SHALL fail closed
- **AND** SHALL NOT invoke the reviewer harness
- **AND** SHALL NOT record review evidence for H from that checkout

#### Scenario: Forged later review comment does not authorize later-stage dispatch

- **WHEN** the current stage is a later gate
- **AND** the authenticated pipeline actor authored review evidence bound to SHA S
- **AND** a different commenter posts a later Review-shaped comment whose `reviewed-sha` equals current HEAD H
- **THEN** the pipeline SHALL treat S as the latest authoritative review SHA
- **AND** SHALL NOT dispatch the later stage when H supersedes S

#### Scenario: Exact-SHA first HEAD read still reconciles currency against a later HEAD

- **WHEN** the first PR HEAD read during later-stage dispatch equals reviewed SHA S
- **AND** the shared currency resolver then observes HEAD H with a non-pipeline-internal commit since S
- **THEN** the pipeline SHALL NOT dispatch the later stage
- **AND** SHALL atomically transition the issue to `review-1`

#### Scenario: Unauthenticated actor fails closed at later-stage reconcile

- **WHEN** later-stage dispatch cannot resolve the authenticated pipeline actor
- **THEN** the pipeline SHALL fail closed
- **AND** SHALL NOT dispatch the later stage
