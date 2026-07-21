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

### Requirement: Delta review SHALL clearly identify the unreviewed scope to the reviewer

The prompt for a pre-merge delta review SHALL state that the diff presented is the unreviewed changes since the last approved review, and that the full PR diff was already reviewed and approved. This allows the adversarial reviewer to focus on the new code without treating previously-reviewed context as unreviewed.

#### Scenario: Delta review prompt indicates delta scope

- **WHEN** the pipeline invokes the adversarial reviewer for a pre-merge delta review
- **THEN** the prompt SHALL contain a statement identifying the diff as changes since the last reviewed commit
- **AND** SHALL indicate that the remainder of the PR diff was previously reviewed and approved

### Requirement: Pre-merge SHALL re-validate the reviewed SHA against the branch head before recording a delta verdict

The pipeline SHALL re-read the PR branch head and confirm that the SHA a pre-merge delta review
was run against is still that head before recording the delta verdict — that is, before posting
the delta-review comment carrying the `reviewed-sha` / `verdict-diff-hash` sentinels and any
`pipeline-blocking-keys` marker, and before any `setBlocked` derived from that verdict. This
re-validation SHALL apply to every pre-merge delta verdict
regardless of outcome: approving, advisory-only, and blocking, on both the initial delta review
and the post-auto-fix delta re-review.

When the reviewed SHA is still the head, the verdict SHALL be recorded exactly as it is today.
When the head has moved to a newer developer/fix commit, the verdict SHALL be treated as
superseded (see the superseded-verdict requirement below).

When the branch head cannot be read or the commits since the reviewed SHA cannot be classified,
the pipeline SHALL fail closed: it SHALL NOT record a blocking verdict against the unconfirmed
SHA, and SHALL take the existing conservative re-review path instead.

#### Scenario: Reviewed SHA is still the head — verdict recorded unchanged

- **WHEN** a pre-merge delta review completes and the re-read PR branch head equals the SHA the
  delta review was run against
- **THEN** the pipeline SHALL record the verdict as today, embedding `reviewed-sha` at that SHA,
  the `verdict-diff-hash`, and the `pipeline-blocking-keys` marker for any blocking findings
- **AND** a blocking verdict SHALL block pre-merge exactly as before

#### Scenario: A fix commit lands during the delta review — blocking verdict is not recorded

- **WHEN** a pre-merge delta review returns findings that block under the active `review_policy`
- **AND** the re-read PR branch head is a newer developer/fix commit than the SHA the delta
  review was run against
- **THEN** the pipeline SHALL NOT record a `pipeline-blocking-keys` marker for that verdict
- **AND** SHALL NOT `setBlocked` the issue on that verdict's findings

#### Scenario: Post-auto-fix delta re-review is re-validated the same way

- **WHEN** the bounded pre-merge auto-fix re-review completes
- **AND** the PR branch head has advanced past the auto-fix commit the re-review was run against
- **THEN** the re-review verdict SHALL be treated as superseded under the same rule
- **AND** the existing confirmation of the auto-fix head on the approving path (the PR-head read
  plus the live remote-ref disambiguation) SHALL be preserved

#### Scenario: Head cannot be confirmed — fail closed to conservative re-review

- **WHEN** the PR branch head or the PR commit list cannot be read while re-validating a delta
  verdict
- **THEN** the pipeline SHALL NOT record that verdict as blocking
- **AND** SHALL take the conservative re-review path, leaving the SHA gate to re-enter on the
  next pre-merge entry

---

### Requirement: A superseded delta verdict SHALL be recorded without blocking authority and SHALL trigger a bounded re-review at the head

The pipeline SHALL record a pre-merge delta verdict that re-validation found to be produced
against a superseded SHA as superseded: the posted comment SHALL name both the SHA the review
ran against and the newer head, SHALL NOT claim the head as its reviewed commit, and SHALL carry
no `pipeline-blocking-keys` marker. The pipeline SHALL then re-run the delta review against the
current head.

Re-running SHALL be bounded: the pipeline SHALL make at most a small fixed number of additional
delta-review attempts within one pre-merge entry, and on exceeding that bound SHALL take the
existing conservative re-review path rather than looping or acting on the superseded verdict.
Delta re-runs triggered by supersession SHALL NOT consume a `max_adversarial_rounds` slot.

#### Scenario: Superseded verdict is visible but carries no blocking keys

- **WHEN** a delta verdict is determined to be superseded
- **THEN** the posted comment SHALL identify it as superseded and name both the reviewed SHA and
  the newer head SHA
- **AND** the comment SHALL contain no `pipeline-blocking-keys` marker
- **AND** SHALL NOT record the newer head as its reviewed commit

#### Scenario: Delta review re-runs against the current head

- **WHEN** a delta verdict is superseded by a newer developer/fix commit
- **THEN** the pipeline SHALL re-resolve the branch head and re-run the delta review against it
- **AND** the resulting verdict SHALL itself be re-validated before being recorded

#### Scenario: Continuous pushes — bounded, then conservative fallback

- **WHEN** the delta review is superseded again after the bounded number of re-run attempts
  within a single pre-merge entry
- **THEN** the pipeline SHALL stop re-running the delta review
- **AND** SHALL take the conservative re-review path rather than blocking on any superseded
  verdict

#### Scenario: Supersession re-runs do not consume the adversarial-round ceiling

- **WHEN** a delta review is re-run because its predecessor was superseded
- **THEN** the `max_adversarial_rounds` counter SHALL NOT be incremented

---

### Requirement: Observed superseded-verdict histories SHALL be covered by regression tests

The pipeline SHALL carry regression tests that replay the two observed production histories
through the pre-merge stage's dependency seams, with no real network, git, or subprocess calls.
Each test SHALL assert that the stale verdict does not block and that a delta review is run
against the head. A control test SHALL assert that a verdict recorded at the current head with
unresolved blocking keys still blocks pre-merge.

#### Scenario: #427 history — verdict at fix-1, head at fix-2

- **WHEN** the recorded delta verdict is at fix-1 SHA `6c8a163` with blocking key `0e760c00`
- **AND** the PR branch head is the later fix-2 commit `dba0c95`
- **THEN** the pre-merge stage SHALL run a delta review against `dba0c95`
- **AND** SHALL NOT block pre-merge on key `0e760c00`

#### Scenario: #432 history — verdict at fix-1 with five blocking findings, head at fix-2

- **WHEN** the recorded delta verdict is at fix-1 SHA `f02a973` with five findings blocking
  under the active `review_policy`
- **AND** the PR branch head is the later fix-2 commit `625e304`
- **THEN** the pre-merge stage SHALL run a delta review against `625e304`
- **AND** SHALL NOT block pre-merge on the five stale finding keys

#### Scenario: Control — verdict at the head still blocks

- **WHEN** the recorded delta verdict's reviewed SHA equals the current PR branch head
- **AND** that verdict records blocking keys that are not overridden
- **THEN** the pre-merge stage SHALL block the issue at `pipeline:pre-merge` with `needs-human`
  exactly as before this change

