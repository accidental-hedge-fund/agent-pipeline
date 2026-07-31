## MODIFIED Requirements

### Requirement: Pre-merge SHALL perform a focused adversarial delta review when the diff changed

When `enforceReviewShaGate` determines that the diff has changed (diff-hash mismatch after the pipeline-internal check), the pipeline SHALL run a delta review: an adversarial (round-2 equivalent) review of only the unreviewed changes (`last-reviewed-sha...HEAD`), rather than routing the issue back to the `review-2` stage for a full PR diff re-review. The delta review SHALL NOT consume a review-2 ceiling slot. When the delta review returns blocking findings, the pipeline SHALL route them through the bounded pre-merge fix-round decision (see the `pre-merge-fix-round` capability) before escalating: it SHALL escalate to `needs-human` only when the fix round is skipped (the auto-fixable category partition is empty — no allowlisted blocking findings), exhausted (an auto-fix has already been attempted for the entry, including a durable noop-clean attempt), the single post-fix or post-noop re-verify still blocks (including residual non-allowlisted findings that remain after a partition auto-fix), or a non-noop auto-fix error path applies (dirty/timeout without successful salvage). A non-empty allowlisted subset SHALL remain auto-fix eligible even when residual non-allowlisted findings are co-batched (partition, not all-or-nothing). A clean no-commit auto-fix outcome SHALL re-verify at HEAD before escalation and SHALL NOT hard-block solely because no commit was produced.

#### Scenario: Delta review approves — pre-merge proceeds

- **WHEN** the pre-merge delta review completes with an `approve` verdict
- **THEN** `enforceReviewShaGate` SHALL return null (pre-merge proceeds normally)
- **AND** SHALL post a delta-review comment embedding the new `reviewed-sha` sentinel (current HEAD)
  and the new `verdict-diff-hash` sentinel

#### Scenario: Delta review finds blocking findings — routed through the fix round

- **WHEN** the pre-merge delta review completes with a `needs-attention` verdict containing findings that block under the active `review_policy`
- **THEN** the pipeline SHALL evaluate the bounded auto-fix eligibility of the blocking findings via category partition before blocking
- **AND** when the auto-fixable (allowlisted) subset is non-empty and no auto-fix has been attempted for the entry, the pipeline SHALL attempt one bounded auto-fix scoped to that subset and re-run the delta review once (see the `pre-merge-fix-round` capability), including the clean-noop re-verify path when the attempt produces no commit
- **AND** residual non-allowlisted findings in the same batch SHALL NOT by themselves skip that attempt
- **AND** when the fix round is skipped (empty auto-fixable subset) or exhausted (a prior auto-fix commit or durable noop-clean attempt exists) or the single re-review still blocks, the pipeline SHALL block pre-merge with a reason that supports human disposition of residual findings (and the more specific no-op still-broken recipe when that path applies)
- **AND** SHALL NOT transition the issue to `review-2`
- **AND** the blocking shall use the same `setBlocked` path as other pre-merge blocking conditions

#### Scenario: Allowlisted concurrency findings do not first-hop skip the fix round

- **WHEN** after partition and demotion the remaining blocking findings are all in
  `{ correctness, missing-dep, concurrency }`
- **AND** no prior auto-fix commit exists for the entry
- **THEN** the pipeline SHALL attempt the bounded auto-fix rather than escalating to
  `needs-human` on the first hop

#### Scenario: Mixed allowlisted + residual does not first-hop skip the fix round

- **WHEN** after partition and demotion the remaining blocking findings include at least one
  category in `{ correctness, missing-dep, concurrency }` and at least one residual
  non-allowlisted category
- **AND** no prior auto-fix commit exists for the entry
- **THEN** the pipeline SHALL attempt the bounded auto-fix for the allowlisted subset rather
  than escalating to `needs-human` on the first hop solely because residual findings are present

#### Scenario: Delta review comment embeds updated sentinels

- **WHEN** the delta review completes (regardless of verdict)
- **THEN** the posted comment SHALL include both `<!-- reviewed-sha: <new-head-sha> -->` and
  `<!-- verdict-diff-hash: <new-hash> -->` sentinels
- **AND** a subsequent pre-merge entry with no further commits SHALL see SHA match and proceed
  without re-review

#### Scenario: Delta review does not count against the review-2 ceiling

- **WHEN** a pre-merge delta review runs
- **THEN** the `max_adversarial_rounds` counter SHALL NOT be incremented
- **AND** the issue's review-2 ceiling budget SHALL be preserved for full review-2 rounds

#### Scenario: Clean no-op auto-fix re-verifies before block

- **WHEN** the bounded auto-fix for a delta blocking round ends with a clean worktree and no new commit
- **THEN** the pipeline SHALL re-verify blocking findings against the current head before `setBlocked`
- **AND** SHALL NOT escalate solely because the auto-fix produced no commit
