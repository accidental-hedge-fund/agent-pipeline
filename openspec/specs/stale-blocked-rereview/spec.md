# stale-blocked-rereview Specification

## Purpose
Resume pre-merge when a leftover blocked label is stale because PR HEAD moved past the blocking reviewed-sha with a non-pipeline-internal commit, so train and loop re-review instead of STOP.

## Requirements

### Requirement: Stale blocked after non-internal HEAD movement SHALL clear and re-review on enter

On enter of pre-merge (including `pipeline single`, durable loop item advance, and train advance of an item that already carries `pipeline:blocked`), when the latest blocking delta-review or review verdict has `reviewed-sha` **S** and the linked PR HEAD is **H**, the pipeline SHALL evaluate staleness before treating the leftover block as terminal. If **H** is a descendant of **S**, or **S** is absent from history because of rebase, **and** at least one commit in the range `S..H` (or the post-rebase equivalent) is **not** pipeline-internal under `isPipelineInternalCommit`, the pipeline SHALL:

1. clear `pipeline:blocked` for that stale cause,
2. re-run delta review (or the conservative full re-review already used when HEAD moves mid-write) against **H**,
3. **not** record an `--override` disposition for security or residual keys solely because HEAD moved.

True residuals that still block on **H** after re-review MAY re-set `pipeline:blocked` / `pipeline:needs-human`. Train and loop SHALL NOT treat the leftover pre-resume `blocked` label as a terminal STOP until this resume has been attempted once for the current advance.

#### Scenario: Blocked on S then non-internal H clears and re-reviews

- **WHEN** an item carries `pipeline:blocked` from a delta review at `reviewed-sha` S
- **AND** PR HEAD H is a descendant of S with at least one non-pipeline-internal commit in S..H
- **AND** the next advance enters pre-merge for that item
- **THEN** the pipeline SHALL clear `pipeline:blocked` for that stale cause
- **AND** SHALL re-enter delta review (or equivalent re-review) against H
- **AND** SHALL NOT STOP the train solely on the pre-resume leftover `blocked` label before that attempt

#### Scenario: HEAD still S keeps the block

- **WHEN** an item is blocked from a review at `reviewed-sha` S
- **AND** PR HEAD is still S with residual blocking findings
- **THEN** the pipeline SHALL keep `pipeline:blocked` / `pipeline:needs-human` as applicable
- **AND** train STOP or per-item hold after the resume check is correct

#### Scenario: Pipeline-internal-only range reuses the verdict

- **WHEN** every commit on the PR since `reviewed-sha` S is pipeline-internal under the existing classification
- **THEN** the pipeline SHALL NOT invalidate the verdict solely for those commits
- **AND** SHALL NOT force a spurious re-review cascade (#98)

#### Scenario: Security residuals are not auto-overridden

- **WHEN** stale-block resume re-runs review against new HEAD H
- **AND** residual findings include non-allowlisted security keys
- **THEN** the pipeline SHALL NOT invent an `--override` for those keys solely because HEAD moved
- **AND** re-block or needs-human on the new HEAD remains available when policy requires it
