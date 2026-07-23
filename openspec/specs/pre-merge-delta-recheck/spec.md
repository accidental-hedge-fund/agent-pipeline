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

### Requirement: The pipeline SHALL count an item's prior pre-merge delta rounds purely from the durable comment thread

The pipeline SHALL expose a pure, deterministic function that returns the number of pre-merge delta rounds already performed for an issue, computed only from that issue's comment list. A comment SHALL count as one delta round when its body begins with the delta-review marker prefix (`## Pre-merge Delta Review`) and its author is the authenticated pipeline actor or a trusted override actor. The function SHALL perform no filesystem, network, git, or subprocess access, and SHALL NOT read run-local state under the run directory, so the count survives a crashed run, a fresh clone, and a host switch.

#### Scenario: Count is derived from trusted delta-review comments

- **WHEN** an issue's comment thread contains three comments authored by the pipeline actor whose bodies begin with the delta-review marker prefix, interleaved with unrelated comments
- **THEN** the counting function SHALL return 3

#### Scenario: Untrusted or non-delta comments are not counted

- **WHEN** a comment begins with the delta-review marker prefix but was authored by an identity that is neither the pipeline actor nor a trusted override actor
- **THEN** that comment SHALL NOT contribute to the count

#### Scenario: Counting is pure

- **WHEN** the counting function is invoked twice with the same comment list
- **THEN** it SHALL return the same value both times
- **AND** SHALL make no filesystem, network, git, or subprocess call

---

### Requirement: Pre-merge SHALL cap delta rounds per item at `review_policy.max_delta_rounds` and apply `ceiling_action` at the ceiling

Before invoking the reviewer for a pre-merge delta round, `enforceReviewShaGate` SHALL compare the item's durable delta-round count to `review_policy.max_delta_rounds`. When the count is greater than or equal to the cap, the pipeline SHALL NOT invoke the reviewer for another delta round and SHALL instead dispose of the item's outstanding blocking delta findings through the configured `ceiling_action`:

- Under `ceiling_action: park`, the pipeline SHALL route the item to the `needs-human` terminal with a punch list of the unresolved blocking delta findings.
- Under `ceiling_action: demote_and_advance`, the pipeline SHALL record below-high blocking delta findings as audited advisory dispositions, capture them in a single tracked follow-up issue, and allow pre-merge to proceed.
- Under either setting, an outstanding blocking delta finding of severity `high` or `critical` SHALL hard-park the item at `needs-human`, mirroring the review-2 ceiling behavior.

The comment the pipeline posts at the ceiling SHALL name the observed round count, the configured cap, and the applied `ceiling_action`. When the count is below the cap, behavior SHALL be unchanged from before this requirement.

#### Scenario: At the cap the reviewer is not invoked again

- **WHEN** an item's durable delta-round count equals `review_policy.max_delta_rounds` and pre-merge re-enters the SHA gate with a changed diff hash
- **THEN** the pipeline SHALL NOT invoke the delta-review seam
- **AND** SHALL apply the configured `ceiling_action`
- **AND** SHALL post a comment naming the observed count, the cap, and the applied action

#### Scenario: Ceiling under park routes to needs-human

- **WHEN** the delta-round cap is reached with outstanding blocking delta findings and `ceiling_action` is `park`
- **THEN** the item SHALL be routed to the `needs-human` terminal
- **AND** the posted punch list SHALL enumerate the unresolved blocking delta findings

#### Scenario: Ceiling under demote_and_advance demotes below-high findings and advances

- **WHEN** the delta-round cap is reached, `ceiling_action` is `demote_and_advance`, and every outstanding blocking delta finding is below `high` severity
- **THEN** those findings SHALL be recorded as audited advisory dispositions
- **AND** SHALL be captured in a single tracked follow-up issue
- **AND** `enforceReviewShaGate` SHALL allow pre-merge to proceed

#### Scenario: High or critical findings hard-park regardless of ceiling_action

- **WHEN** the delta-round cap is reached with at least one outstanding blocking delta finding of severity `high` or `critical` and `ceiling_action` is `demote_and_advance`
- **THEN** the item SHALL be routed to the `needs-human` terminal
- **AND** SHALL NOT advance past pre-merge

#### Scenario: Below the cap behavior is unchanged

- **WHEN** an item's durable delta-round count is strictly less than `review_policy.max_delta_rounds`
- **THEN** the delta review SHALL run exactly as it did before this requirement

---

### Requirement: The delta-round ceiling SHALL be budgeted independently of `max_adversarial_rounds`

Running or ceiling-disposing a pre-merge delta round SHALL NOT increment or consume the `max_adversarial_rounds` review-2 round budget, and reaching `max_adversarial_rounds` SHALL NOT consume delta-round budget. The two ceilings SHALL share only the `ceiling_action` setting.

#### Scenario: Delta rounds do not consume review-2 budget

- **WHEN** an item performs delta rounds up to and including the `max_delta_rounds` ceiling
- **THEN** the `max_adversarial_rounds` counter SHALL be unchanged
- **AND** the item's remaining review-2 ceiling budget SHALL be unchanged

#### Scenario: Review-2 rounds do not consume delta budget

- **WHEN** an item performs review-2 rounds
- **THEN** its durable delta-round count SHALL be unchanged

---

### Requirement: A delta round whose blocking findings show declining confidence on settled axes SHALL be flagged as suspected churn

When the pure churn detector reports suspected churn for a delta round's blocking findings against the prior-round digest, the pipeline SHALL label the posted delta-review comment as a suspected-churn round, naming the settled axes and the prior-versus-new confidences, and SHALL emit exactly one suspected-churn event for that round. The flag SHALL be audit-only: it SHALL NOT by itself change whether the round's findings block, and the round's blocking disposition SHALL be decided by the active `review_policy` and the settled-finding guards exactly as it would without the flag.

#### Scenario: Suspected-churn round is labelled and evented

- **WHEN** a delta round's blocking findings all sit on settled axes at strictly lower confidence than each axis's prior maximum
- **THEN** the posted delta-review comment SHALL carry a suspected-churn label naming the settled axes and the prior and new confidences
- **AND** exactly one suspected-churn event SHALL be emitted for that round

#### Scenario: The churn flag does not alter blocking disposition

- **WHEN** a delta round is flagged as suspected churn
- **THEN** the set of blocking findings SHALL be identical to the set produced for the same findings, policy, overrides, and settled entries without the flag

#### Scenario: A non-churn round carries no label or event

- **WHEN** the churn detector reports no suspected churn for a delta round
- **THEN** the posted comment SHALL carry no suspected-churn label
- **AND** no suspected-churn event SHALL be emitted

---

### Requirement: Delta-round observability SHALL be recorded in the run events and the evidence bundle

For each pre-merge delta round performed, the pipeline SHALL emit one `delta_round` event carrying the round number and the configured cap. When the cap is reached, it SHALL emit one `delta_round_ceiling` event carrying the observed count, the cap, and the applied `ceiling_action`. The evidence bundle SHALL record the item's delta-round count, the configured cap, the ceiling disposition when one occurred, and any suspected-churn flags. As with all evidence-bundle writes, a failure to record SHALL NOT fail the run.

#### Scenario: Each delta round emits a round event

- **WHEN** a pre-merge delta round runs
- **THEN** exactly one `delta_round` event SHALL be appended carrying that round's number and the configured cap

#### Scenario: Ceiling emits a ceiling event

- **WHEN** the delta-round cap is reached
- **THEN** exactly one `delta_round_ceiling` event SHALL be appended carrying the observed count, the cap, and the applied `ceiling_action`

#### Scenario: Evidence bundle records delta-round accounting

- **WHEN** a run performs at least one pre-merge delta round
- **THEN** the evidence bundle SHALL report the delta-round count, the cap, the ceiling disposition when one occurred, and any suspected-churn flags

#### Scenario: Bundle write failure is non-fatal

- **WHEN** recording delta-round accounting into the evidence bundle fails
- **THEN** the run SHALL continue and the pre-merge outcome SHALL be unaffected

---

### Requirement: The five-round oscillation history SHALL be covered by a regression test

The test suite SHALL include a regression test replaying the observed five-delta-round history (PraxisIQ/fuseiq-core#95): four rounds of genuine blocking findings followed by a fifth round re-raising a settled axis under new finding keys, re-worded titles, declining confidence, and a recommendation that reinstates a design a prior round required removed. The test SHALL use fake comment fixtures with no network, git, or subprocess access, and SHALL assert both that the cap prevents the fifth round from being reviewed under the default configuration and that, when the fifth round's findings are partitioned, they are demoted rather than blocking.

#### Scenario: Replay asserts the loop is bounded and the round-5 findings are demoted

- **WHEN** the five-round fixture history is replayed against the gate and the partitioner
- **THEN** the fifth delta round SHALL NOT be invoked under the default `max_delta_rounds`
- **AND** the round-5 findings, when partitioned against the settled entries, SHALL land in the advisory partition

### Requirement: The pre-merge delta review SHALL carry a resolved-finding verification context

The pipeline SHALL derive, from the prior-round digest already built for the pre-merge delta review,
the set of prior blocking findings whose recorded resolution is `resolved-by-fix` or `overridden`,
and SHALL render them into the delta-review prompt as a resolved-finding verification section. Each
entry SHALL carry the finding key, the surface (file and category) recorded for it, the finding
title, the round that settled it, and its disposition. The section SHALL be derived only from the
digest — the pipeline SHALL NOT introduce a separate durable artifact, comment marker, or run-local
store for it — and SHALL therefore inherit the digest's trust model and fail-closed behavior.

#### Scenario: Settled findings are rendered into the delta prompt

- **WHEN** a pre-merge delta review is built and the prior-round digest contains findings resolved
  by fix and/or settled by override
- **THEN** the delta-review prompt SHALL contain a resolved-finding verification section
- **AND** the section SHALL list each such finding's key, surface, title, settling round, and
  disposition (`resolved-by-fix` or `overridden`)
- **AND** findings that were advisory-only or still outstanding SHALL NOT appear in it

#### Scenario: Fail-closed digest yields no verification context

- **WHEN** the prior-round digest is empty because the authenticated actor could not be resolved
- **THEN** the delta-review prompt SHALL contain no resolved-finding verification section

### Requirement: The verification section SHALL require HEAD-state evidence to re-assert a settled finding

The resolved-finding verification section SHALL instruct the reviewer that each listed finding is
presumed resolved at the current head, and that re-asserting it as blocking requires citing the
current state of the code (the file content supplied in the prompt). The instruction SHALL state
explicitly that the finding's absence from the narrow delta diff — for example "outside this
delta's narrow fixes" or "these commits do not address it" — is NOT sufficient grounds to re-assert
it, and that a reviewer unable to verify persistence against the supplied file state SHALL NOT
raise the finding as blocking.

#### Scenario: Instruction text is present and drift-guarded

- **WHEN** the resolved-finding verification section is rendered
- **THEN** it SHALL state that listed findings are presumed resolved at HEAD
- **AND** SHALL require current-file-state evidence for any re-assertion
- **AND** SHALL reject narrow-delta-scope rationale as grounds for re-assertion
- **AND** a test SHALL pin this instruction so the prompt cannot silently drop it

### Requirement: The delta review SHALL supply HEAD file state for settled findings' surfaces

For each distinct file named by a settled finding's surface, the pipeline SHALL read that file's
content at the reviewed head from the delta reviewer's worktree — the same directory the delta diff
is computed from — and SHALL include it in the delta-review prompt labelled with its repository
path. Reads SHALL go through an injectable seam so unit tests perform no filesystem access. Files
SHALL be emitted deduplicated and in ascending path order. Content SHALL be bounded by a per-file
and a total byte cap, and any trimmed content SHALL be marked as truncated in-band. A file that is
absent or unreadable at the head SHALL be rendered as an explicit not-present note rather than
silently omitted.

#### Scenario: Settled surfaces' files are injected at HEAD

- **WHEN** the digest carries settled findings whose surfaces name `core/scripts/a.ts` and
  `core/scripts/b.ts`
- **THEN** the delta-review prompt SHALL include the head content of both files read from the delta
  worktree path
- **AND** each SHALL be labelled with its repository path
- **AND** the files SHALL appear in ascending path order with duplicates collapsed

#### Scenario: Oversized content is truncated and disclosed

- **WHEN** an injected file exceeds the per-file cap, or the accumulated content exceeds the total
  cap
- **THEN** the emitted content SHALL be trimmed at the cap
- **AND** the trimmed entry SHALL be marked as truncated in the prompt

#### Scenario: Missing file at HEAD is disclosed, not dropped

- **WHEN** a settled finding's surface names a file that does not exist at the reviewed head
- **THEN** the prompt SHALL render an explicit note that the file is not present at HEAD
- **AND** SHALL NOT omit the entry silently

### Requirement: Injected resolution context and file state SHALL be fenced as untrusted evidence

The resolved-finding verification section and the injected file content SHALL be sanitized and
fenced on the same terms as the cross-round digest: fences SHALL be chosen so embedded content
cannot escape them, and the surrounding text SHALL mark the content as external evidence to be
evaluated, not as instructions to be followed.

#### Scenario: Embedded fences and directives cannot escape

- **WHEN** an injected file's content contains a code fence or text resembling reviewer
  instructions
- **THEN** the rendered section SHALL keep that content inside its fence
- **AND** SHALL label it as untrusted external evidence

### Requirement: An unverified re-assertion of a settled finding SHALL be demoted to advisory

The pipeline SHALL partition as advisory rather than blocking any pre-merge delta finding whose
surface matches a settled finding's surface and whose body cites no evidence drawn from the
supplied head file state. The demotion SHALL reuse the existing
settled-finding demotion path rather than introducing a parallel mechanism, and SHALL name the
settled finding and its settling round in both the posted review comment and the emitted run event,
with a reason distinguishing it from an unacknowledged reversal. A delta finding on a settled
surface that does cite current file state SHALL remain blocking under the normal severity and
confidence policy.

#### Scenario: Narrow-delta rationale is demoted

- **WHEN** a delta finding re-asserts a settled finding's surface with the rationale that the delta
  does not address it, citing no head file state
- **THEN** the finding SHALL be classified advisory, not blocking
- **AND** the review comment and the run event SHALL name the settled finding key and its settling
  round
- **AND** the run SHALL NOT require an audited override to advance

#### Scenario: Verified regression on a settled surface still blocks

- **WHEN** a delta finding on a settled surface cites the current head file state as evidence that
  the behavior regressed
- **THEN** the finding SHALL be evaluated under the normal severity and confidence policy
- **AND** SHALL block when it meets the policy's blocking threshold

### Requirement: The delta path SHALL be unchanged when there is no settled history

When the prior-round digest carries no settled findings, the pipeline SHALL render no
resolved-finding verification section, SHALL perform no head file reads, and SHALL produce a
delta-review prompt identical to the one produced before this change. No finding SHALL be demoted by
the settled-surface evidence rule in that case.

#### Scenario: First delta round is a no-op

- **WHEN** a pre-merge delta review runs with a digest containing no resolved or overridden findings
- **THEN** the prompt SHALL contain no resolved-finding verification section and no injected file
  content
- **AND** no file read SHALL be attempted
- **AND** every returned finding SHALL be partitioned exactly as it is today

### Requirement: Regression coverage SHALL pin the #451 re-assertion history

The repository SHALL carry a regression fixture replaying the #451 case: a prior-round history in
which findings `ac3bdbd2`, `4040cada`, and `edfd3cf1` are recorded blocking and then settled on
their recorded surfaces, followed by a narrow delta whose review re-asserts all three with
narrow-delta rationale and no head-state evidence. The fixture SHALL assert that all three are
demoted to advisory, that the delta round advances without an audited override, and that the
prompt built for that delta carries the verification section and the head content of the settled
surfaces' files.

#### Scenario: #451 history replays without overrides

- **WHEN** the #451 fixture history is replayed through the pre-merge delta path
- **THEN** all three re-asserted findings SHALL be advisory
- **AND** the run SHALL advance without recording an override disposition
- **AND** the assertions SHALL fail against the pre-change behavior

