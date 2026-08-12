## MODIFIED Requirements

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
