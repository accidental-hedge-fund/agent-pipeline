## ADDED Requirements

### Requirement: The unresolved-blocking-keys gate SHALL ignore verdicts superseded by a newer developer commit

The pre-merge gate SHALL first establish that a recorded verdict is current before re-evaluating
that verdict's `pipeline-blocking-keys` marker against current overrides. A recorded
verdict is current when its `reviewed-sha` equals the PR branch head, or when every commit on the
PR since that `reviewed-sha` is pipeline-internal under the existing classification. A recorded
verdict whose `reviewed-sha` precedes a newer developer/fix commit on the PR is stale: the
pipeline SHALL NOT block pre-merge on its recorded blocking keys, and SHALL instead route to a
review of the current head.

This rule SHALL NOT alter the pipeline-internal-commit classification, and SHALL NOT weaken
blocking for current verdicts: an unresolved blocking key on a current verdict still holds the
gate, and clearing the blocked label or landing a no-op or OpenSpec-archive commit SHALL NOT
launder it.

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
  (`chore: archive OpenSpec change(s) for #…`)
- **AND** that verdict records one or more un-overridden blocking keys
- **THEN** the verdict SHALL be treated as current
- **AND** the gate SHALL keep the issue blocked on those keys — a no-op or archive commit SHALL
  NOT bypass the gate

#### Scenario: Staleness is judged by PR commit order, not comment order

- **WHEN** the gate evaluates whether a recorded verdict is stale
- **THEN** it SHALL decide using the PR's commit list and the pipeline-internal classification
- **AND** SHALL NOT rely on comment timestamps or comment ordering to establish currency
