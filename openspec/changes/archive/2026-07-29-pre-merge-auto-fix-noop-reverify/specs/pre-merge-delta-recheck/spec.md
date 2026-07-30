## MODIFIED Requirements

### Requirement: Pre-merge SHALL perform a focused adversarial delta review when the diff changed

When `enforceReviewShaGate` determines that the diff has changed (diff-hash mismatch after the pipeline-internal check), the pipeline SHALL run a delta review: an adversarial (round-2 equivalent) review of only the unreviewed changes (`last-reviewed-sha...HEAD`), rather than routing the issue back to the `review-2` stage for a full PR diff re-review. The delta review SHALL NOT consume a review-2 ceiling slot. When the delta review returns blocking findings, the pipeline SHALL route them through the bounded pre-merge fix-round decision (see the `pre-merge-fix-round` capability) before escalating: it SHALL escalate to `needs-human` only when the fix round is skipped (a blocking finding falls outside the auto-fixable category allowlist), exhausted (an auto-fix has already been attempted for the entry, including a durable noop-clean attempt), the single post-fix or post-noop re-verify still blocks, or a non-noop auto-fix error path applies (dirty/timeout without successful salvage). A clean no-commit auto-fix outcome SHALL re-verify at HEAD before escalation and SHALL NOT hard-block solely because no commit was produced.

#### Scenario: Delta review approves — pre-merge proceeds

- **WHEN** the pre-merge delta review completes with an `approve` verdict
- **THEN** `enforceReviewShaGate` SHALL return null (pre-merge proceeds normally)
- **AND** SHALL post a delta-review comment embedding the new `reviewed-sha` sentinel (current HEAD) and the new `verdict-diff-hash` sentinel

#### Scenario: Delta review finds blocking findings — routed through the fix round

- **WHEN** the pre-merge delta review completes with a `needs-attention` verdict containing findings that block under the active `review_policy`
- **THEN** the pipeline SHALL evaluate the bounded auto-fix eligibility of the blocking findings before blocking
- **AND** when all blocking findings are auto-fixable and no auto-fix has been attempted for the entry, the pipeline SHALL attempt one bounded auto-fix and re-run the delta review once (see the `pre-merge-fix-round` capability), including the clean-noop re-verify path when the attempt produces no commit
- **AND** when the fix round is skipped (a non-allowlisted category) or exhausted (a prior auto-fix commit or durable noop-clean attempt exists) or the single re-review still blocks, the pipeline SHALL block pre-merge with the reason "Pre-merge delta review found blocking findings; fix required before merging." (or the more specific no-op still-broken recipe when that path applies)
- **AND** SHALL NOT transition the issue to `review-2`
- **AND** the blocking shall use the same `setBlocked` path as other pre-merge blocking conditions

#### Scenario: Delta review comment embeds updated sentinels

- **WHEN** the delta review completes (regardless of verdict)
- **THEN** the posted comment SHALL include both `<!-- reviewed-sha: <new-head-sha> -->` and `<!-- verdict-diff-hash: <new-hash> -->` sentinels
- **AND** a subsequent pre-merge entry with no further commits SHALL see SHA match and proceed without re-review

#### Scenario: Delta review does not count against the review-2 ceiling

- **WHEN** a pre-merge delta review runs
- **THEN** the `max_adversarial_rounds` counter SHALL NOT be incremented
- **AND** the issue's review-2 ceiling budget SHALL be preserved for full review-2 rounds

#### Scenario: Clean no-op auto-fix re-verifies before block

- **WHEN** the bounded auto-fix for a delta blocking round ends with a clean worktree and no new commit
- **THEN** the pipeline SHALL re-verify blocking findings against the current head before `setBlocked`
- **AND** SHALL NOT escalate solely because the auto-fix produced no commit

## ADDED Requirements

### Requirement: Delta review SHALL fail closed on unsupported still-broken claims against correct HEAD

The pipeline SHALL NOT treat a pre-merge delta finding as blocking when that finding asserts that
HEAD still implements incorrect classification or control-flow behavior while the **cited line
range** of the file on the reviewed SHA already implements the recommended **known pipeline**
classification/behavior, unless the finding cites contradictory current-file-state evidence or a
contradictory failing executable check. Only findings with an explicit classification/control-flow
claim shape **and** a recommendation that names a known pipeline classification/status token are
eligible for this demotion; arbitrary backticked identifiers alone SHALL NOT qualify. The
pipeline SHALL require the recommended token to appear in the finding's cited line range (not
merely anywhere in the file); when `line_start` is absent or the cited region cannot prove the
recommendation, the finding SHALL remain blocking (fail closed). Whole-file token presence on an
unrelated branch in the same file SHALL NOT demote a finding about a different cited region. A
reviewer claim that the behavior is wrong without HEAD region evidence, when the cited region
already matches the recommendation, SHALL be demoted to advisory or dropped from the blocking set
under the existing partition / settled-surface demotion paths where applicable, or rejected by the
post-noop re-verify when the finding first appears only after an auto-fix no-op.

#### Scenario: HEAD already implements recommended classification — not blocking after re-verify

- **WHEN** a delta finding claims an off-ramp is misclassified (for example as `openspec-invalid`)
- **AND** the cited line range on the reviewed head already routes that off-ramp to `needs-human`
  (or the recommended known pipeline classification) with no contradictory failing check
- **THEN** re-verify (or the deterministic HEAD assertion) SHALL NOT leave that finding as blocking
- **AND** the pipeline SHALL NOT set `needs-human` solely for that finding

#### Scenario: HEAD still wrong with current-file evidence — remains blocking

- **WHEN** a delta finding cites current head file state showing the incorrect classification or
  control-flow is still present
- **THEN** the finding SHALL remain subject to normal severity and confidence policy
- **AND** SHALL block when it meets the policy threshold after any auto-fix attempt is exhausted

#### Scenario: Pure classification claim without HEAD evidence fails closed to non-block on re-verify of already-correct code

- **WHEN** re-verify evaluates a pure classification/control-flow finding against the cited region
  of HEAD content that already implements the recommendation and the finding provides no
  contradictory executable evidence
- **THEN** that finding SHALL NOT remain in the blocking partition for escalation

#### Scenario: Token elsewhere in the same file does not demote a different cited region

- **WHEN** a pure classification finding cites a line range that still implements the wrong
  classification
- **AND** another region of the same file already contains the recommended classification token
- **THEN** the finding SHALL remain blocking
- **AND** the pipeline SHALL NOT demote solely because the recommended token appears elsewhere in
  the file

#### Scenario: Missing cited line range fails closed to blocking

- **WHEN** a pure classification finding has no `line_start` (no cited region)
- **AND** the recommended token appears somewhere in the file
- **THEN** the deterministic HEAD check SHALL NOT demote the finding
- **AND** the finding SHALL remain subject to normal blocking policy

### Requirement: Post-auto-fix clean no-op SHALL re-enter delta verification at the unchanged head

The pre-merge stage SHALL, when the bounded pre-merge auto-fix returns a clean no-op (no new
commit, clean worktree), re-enter delta verification against the same head SHA the auto-fix started
from — not against a fabricated new head — using the same re-validation, supersession, and fail-closed
rules as the post-fix-commit re-review path. A clean re-verify SHALL allow pre-merge to proceed; a
still-blocking re-verify SHALL escalate without a second fix attempt. The re-verify's
`reviewed-sha` / `verdict-diff-hash` sentinels SHALL be recorded against the head that was actually
reviewed when a verdict is recorded.

#### Scenario: No-op re-verify uses the pre-fix head as the reviewed head

- **WHEN** auto-fix ends noop-clean at head SHA H
- **THEN** the re-verify SHALL evaluate findings against H (not a new auto-fix commit SHA)
- **AND** SHALL NOT invent a commit or rewrite history to create a re-review target

#### Scenario: Approving no-op re-verify proceeds like an approving post-fix re-review

- **WHEN** the no-op re-verify returns no blocking findings under the active `review_policy`
- **THEN** `enforceReviewShaGate` SHALL return null (pre-merge proceeds)
- **AND** SHALL NOT leave the issue `pipeline:blocked` for the prior delta findings alone
