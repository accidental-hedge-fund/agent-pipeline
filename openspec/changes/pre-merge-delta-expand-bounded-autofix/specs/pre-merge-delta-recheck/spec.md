## MODIFIED Requirements

### Requirement: Pre-merge SHALL perform a focused adversarial delta review when the diff changed

When `enforceReviewShaGate` determines that the diff has changed (diff-hash mismatch after the pipeline-internal check), the pipeline SHALL run a delta review: an adversarial (round-2 equivalent) review of only the unreviewed changes (`last-reviewed-sha...HEAD`), rather than routing the issue back to the `review-2` stage for a full PR diff re-review. The delta review SHALL NOT consume a review-2 ceiling slot. When the delta review returns blocking findings, the pipeline SHALL first apply prior-round advisory carry-forward disposition (see the advisory carry-forward requirement) and the settled-finding guards, then route any remaining blocking findings through the bounded pre-merge fix-round decision (see the `pre-merge-fix-round` capability) before escalating: it SHALL escalate to `needs-human` only when the fix round is skipped (a remaining blocking finding falls outside the auto-fixable category allowlist `{ correctness, missing-dep, concurrency }`) or exhausted (an auto-fix has already been attempted for the entry) or the single re-review still blocks.

#### Scenario: Delta review approves — pre-merge proceeds

- **WHEN** the pre-merge delta review completes with an `approve` verdict
- **THEN** `enforceReviewShaGate` SHALL return null (pre-merge proceeds normally)
- **AND** SHALL post a delta-review comment embedding the new `reviewed-sha` sentinel (current HEAD)
  and the new `verdict-diff-hash` sentinel

#### Scenario: Delta review finds blocking findings — routed through the fix round

- **WHEN** the pre-merge delta review completes with a `needs-attention` verdict containing findings
  that block under the active `review_policy` after advisory carry-forward and settled-finding
  demotion
- **THEN** the pipeline SHALL evaluate the bounded auto-fix eligibility of the remaining blocking
  findings before blocking
- **AND** when all remaining blocking findings are auto-fixable (including `concurrency`) and no
  auto-fix has been attempted for the entry, the pipeline SHALL attempt one bounded auto-fix and
  re-run the delta review once (see the `pre-merge-fix-round` capability)
- **AND** when the fix round is skipped (a non-allowlisted category) or exhausted (a prior auto-fix
  commit exists) or the single re-review still blocks, the pipeline SHALL block pre-merge with the
  reason "Pre-merge delta review found blocking findings; fix required before merging."
- **AND** SHALL NOT transition the issue to `review-2`
- **AND** the blocking shall use the same `setBlocked` path as other pre-merge blocking conditions

#### Scenario: Allowlisted concurrency findings do not first-hop skip the fix round

- **WHEN** after partition and demotion the remaining blocking findings are all in
  `{ correctness, missing-dep, concurrency }`
- **AND** no prior auto-fix commit exists for the entry
- **THEN** the pipeline SHALL attempt the bounded auto-fix rather than escalating to
  `needs-human` on the first hop

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

## ADDED Requirements

### Requirement: Prior-round advisory findings SHALL carry forward at pre-merge delta without unverified re-litigation

The pipeline SHALL treat a same-fingerprint or same-surface reappearance of a prior-round **advisory** finding (severity/confidence below the block threshold, or explicitly `blocking: false`, where the issue advanced past that review) in a later pre-merge delta review as a carry-forward candidate derived from the prior-round digest already built for the delta review. Carry-forward SHALL coordinate with the existing resolved-finding verification and settled-surface demotion paths rather than introducing a separate durable store. A carry-forward candidate SHALL be demoted to advisory (not blocking) when the delta finding cites no evidence drawn from the supplied head file state beyond re-asserting the prior concern. The posted review comment and the emitted run event SHALL name the prior advisory finding and the carry-forward demotion reason. A delta finding on the same surface/fingerprint that cites current head-state evidence of a new or worsened defect SHALL remain subject to normal severity and confidence policy (and, if still blocking, the `pre-merge-fix-round` allowlist path). Carry-forward SHALL NOT auto-fix or auto-dismiss `security` findings by category alone: if a security finding remains blocking after the evidence gate, it escalates without auto-fix per the allowlist. Carry-forward SHALL NOT weaken verified regressions.

#### Scenario: Advisory reappears as HIGH without new head evidence — demoted

- **WHEN** review-2 advanced with an advisory finding on surface `file|category` (or the same
  stable fingerprint)
- **AND** a later pre-merge delta review re-raises a blocking finding on that same surface or
  fingerprint
- **AND** the finding body cites no current head file state as evidence of a new or worsened defect
- **THEN** the pipeline SHALL classify that finding as advisory, not blocking
- **AND** SHALL name the prior advisory disposition in the review comment and run event
- **AND** SHALL NOT require an audited override solely to advance past that reappearance

#### Scenario: Verified regression on a prior advisory surface still blocks

- **WHEN** a delta finding matches a prior advisory surface or fingerprint
- **AND** the finding cites current head file state as evidence that the defect is new or worsened
- **THEN** the finding SHALL be evaluated under the normal severity and confidence policy
- **AND** when it blocks, the pipeline SHALL route it through the bounded auto-fix allowlist (or
  escalate if non-allowlisted) exactly as for other blocking findings

#### Scenario: No prior advisory history — no carry-forward demotion

- **WHEN** the prior-round digest carries no advisory findings for a surface
- **THEN** no finding SHALL be demoted solely by the advisory carry-forward rule
- **AND** partition behavior for that surface SHALL match the pre-change baseline aside from other
  settled-finding rules

#### Scenario: Carry-forward coordinates with resolved-finding verification

- **WHEN** a surface has both a prior settled (`resolved-by-fix` / `overridden`) entry and a prior
  advisory entry
- **THEN** the pipeline SHALL apply settled-finding demotion and advisory carry-forward without
  double-blocking the same unverified re-assertion
- **AND** SHALL NOT introduce a second durable artifact store for advisory carry-forward beyond the
  existing prior-round digest
