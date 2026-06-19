# pre-merge-delta-recheck Specification

## Purpose
TBD - created by archiving change cache-review-verdict-by-diff-hash. Update Purpose after archive.
## Requirements
### Requirement: Pre-merge SHA gate SHALL check the diff-hash cache before triggering re-review

When `enforceReviewShaGate` detects that HEAD moved with non-pipeline-internal commits (triggering the re-review path), the pipeline SHALL perform a diff-hash cache check before routing back to a review stage. The pipeline SHALL fetch the current PR diff hash and compare it to the `verdict-diff-hash` sentinel in the most recent prior review comment. If the hashes match, the prior verdict SHALL be treated as valid and the gate SHALL return without triggering re-review. If the hashes differ, the gate SHALL proceed to the delta review path (not a full review-2 round).

#### Scenario: SHA mismatch but same diff hash — verdict reused, no re-review

- **WHEN** `enforceReviewShaGate` detects HEAD moved past the reviewed SHA with at least one non-pipeline-internal commit
- **AND** the current PR diff hash matches the `verdict-diff-hash` sentinel in the prior review comment
- **THEN** the gate SHALL return null (pre-merge proceeds)
- **AND** SHALL NOT transition the issue to a review stage
- **AND** SHALL post a brief notice of the form "Diff unchanged since last review; verdict reused."

#### Scenario: SHA mismatch and diff hash changed — proceeds to delta review

- **WHEN** `enforceReviewShaGate` detects HEAD moved with non-pipeline-internal commits
- **AND** the current PR diff hash does NOT match the `verdict-diff-hash` sentinel in the prior review comment (or no sentinel is present)
- **THEN** the gate SHALL NOT route the issue back to `review-2`
- **AND** SHALL instead invoke the delta review path (see delta review requirements below)

#### Scenario: Pipeline-internal commit exemption is checked first

- **WHEN** HEAD moved only by OpenSpec archive commits since the review
- **THEN** the gate SHALL return null without performing the diff-hash check (existing pipeline-internal exemption behavior is preserved and takes precedence)

---

### Requirement: Pre-merge SHALL perform a focused adversarial delta review when the diff changed

When `enforceReviewShaGate` determines that the diff has changed (diff-hash mismatch after the pipeline-internal check), the pipeline SHALL run a delta review: an adversarial (round-2 equivalent) review of only the unreviewed changes (`last-reviewed-sha...HEAD`), rather than routing the issue back to the `review-2` stage for a full PR diff re-review. The delta review SHALL NOT consume a review-2 ceiling slot.

#### Scenario: Delta review approves — pre-merge proceeds

- **WHEN** the pre-merge delta review completes with an `approve` verdict
- **THEN** `enforceReviewShaGate` SHALL return null (pre-merge proceeds normally)
- **AND** SHALL post a delta-review comment embedding the new `reviewed-sha` sentinel (current HEAD) and the new `verdict-diff-hash` sentinel

#### Scenario: Delta review finds blocking findings — pre-merge is blocked

- **WHEN** the pre-merge delta review completes with a `needs-attention` verdict containing findings that block under the active `review_policy`
- **THEN** the pipeline SHALL block pre-merge with the reason "Pre-merge delta review found blocking findings; fix required before merging."
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

---

### Requirement: Delta review SHALL clearly identify the unreviewed scope to the reviewer

The prompt for a pre-merge delta review SHALL state that the diff presented is the unreviewed changes since the last approved review, and that the full PR diff was already reviewed and approved. This allows the adversarial reviewer to focus on the new code without treating previously-reviewed context as unreviewed.

#### Scenario: Delta review prompt indicates delta scope

- **WHEN** the pipeline invokes the adversarial reviewer for a pre-merge delta review
- **THEN** the prompt SHALL contain a statement identifying the diff as changes since the last reviewed commit
- **AND** SHALL indicate that the remainder of the PR diff was previously reviewed and approved

