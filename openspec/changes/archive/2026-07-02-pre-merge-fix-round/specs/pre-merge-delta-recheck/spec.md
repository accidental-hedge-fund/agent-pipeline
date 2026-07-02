## MODIFIED Requirements

### Requirement: Pre-merge SHALL perform a focused adversarial delta review when the diff changed

When `enforceReviewShaGate` determines that the diff has changed (diff-hash mismatch after the pipeline-internal check), the pipeline SHALL run a delta review: an adversarial (round-2 equivalent) review of only the unreviewed changes (`last-reviewed-sha...HEAD`), rather than routing the issue back to the `review-2` stage for a full PR diff re-review. The delta review SHALL NOT consume a review-2 ceiling slot. When the delta review returns blocking findings, the pipeline SHALL route them through the bounded pre-merge fix-round decision (see the `pre-merge-fix-round` capability) before escalating: it SHALL escalate to `needs-human` only when the fix round is skipped (a blocking finding falls outside the auto-fixable category allowlist) or exhausted (an auto-fix has already been attempted for the entry).

#### Scenario: Delta review approves — pre-merge proceeds

- **WHEN** the pre-merge delta review completes with an `approve` verdict
- **THEN** `enforceReviewShaGate` SHALL return null (pre-merge proceeds normally)
- **AND** SHALL post a delta-review comment embedding the new `reviewed-sha` sentinel (current HEAD) and the new `verdict-diff-hash` sentinel

#### Scenario: Delta review finds blocking findings — routed through the fix round

- **WHEN** the pre-merge delta review completes with a `needs-attention` verdict containing findings that block under the active `review_policy`
- **THEN** the pipeline SHALL evaluate the bounded auto-fix eligibility of the blocking findings before blocking
- **AND** when all blocking findings are auto-fixable and no auto-fix has been attempted for the entry, the pipeline SHALL attempt one bounded auto-fix and re-run the delta review once (see the `pre-merge-fix-round` capability)
- **AND** when the fix round is skipped (a non-allowlisted category) or exhausted (a prior auto-fix commit exists) or the single re-review still blocks, the pipeline SHALL block pre-merge with the reason "Pre-merge delta review found blocking findings; fix required before merging."
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
