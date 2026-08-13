# stale-blocked-rereview Specification

## Purpose
Resume pre-merge when a leftover blocked label is stale because PR HEAD moved past the blocking reviewed-sha with a non-pipeline-internal commit, so train and loop re-review instead of STOP.

## Requirements

### Requirement: Stale blocked after non-internal HEAD movement SHALL clear and re-review on enter

On enter of pre-merge (including `pipeline single`, durable loop item advance, and train advance of an item that already carries `pipeline:blocked`), when the latest blocking delta-review or review verdict has `reviewed-sha` **S** and the linked PR HEAD is **H**, the pipeline SHALL evaluate staleness before treating the leftover block as terminal.

The pipeline SHALL clear the leftover block and re-enter review when either:

1. **H** is a descendant of **S** (or the PR commit list shows non-pipeline-internal commits in the range `S..H`) under the shared supersession classification used by the pre-merge SHA gate, **or**
2. **S** is absent from PR history (rebase/squash or otherwise unlocatable) **and** **H** ≠ **S**, so the pipeline cannot prove a pipeline-internal-only tip advance.

In those resume cases the pipeline SHALL:

1. clear `pipeline:blocked` for that stale cause,
2. re-run delta review (or the conservative full re-review already used when HEAD moves mid-write / currency is unclassifiable) against **H**,
3. **not** record an `--override` disposition for security or residual keys solely because HEAD moved.

True residuals that still block on **H** after re-review MAY re-set `pipeline:blocked` / `pipeline:needs-human`. Train and loop SHALL NOT treat the leftover pre-resume `blocked` label as a terminal STOP until this resume has been attempted once for the current advance. When **H** still equals **S**, or when every commit since **S** is pipeline-internal under `isPipelineInternalCommit` and currency is classified current for approval-reuse purposes, the leftover block SHALL remain (subject to residual SHA-scope re-evaluation at the live head when the gate re-enters for residual keys). When the linked PR or HEAD cannot be read at all, the pipeline SHALL fail closed and keep the block.

#### Scenario: Blocked on S then non-internal H clears and re-reviews

- **WHEN** an item carries `pipeline:blocked` from a delta review at `reviewed-sha` S
- **AND** PR HEAD H is a descendant of S with at least one non-pipeline-internal commit in S..H
- **AND** the next advance enters pre-merge (or another resume-eligible stage) for that item
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
- **AND** currency classifies the reviewed-sha as still current for verdict reuse (#98)
- **THEN** the pipeline SHALL NOT invalidate the verdict solely for those commits
- **AND** SHALL NOT force a spurious re-review cascade (#98)
- **AND** SHALL NOT clear `pipeline:blocked` solely because an archive/sentinel tip advanced

#### Scenario: Reviewed-sha absent after rebase resumes at HEAD

- **WHEN** an item carries `pipeline:blocked` from a review at `reviewed-sha` S
- **AND** PR HEAD H is not equal to S
- **AND** S is absent from the PR commit list (rebase, squash, or otherwise unlocatable)
- **THEN** the pipeline SHALL clear `pipeline:blocked` for that stale cause
- **AND** SHALL re-enter delta review or the conservative re-review path against H
- **AND** SHALL NOT leave the item permanently parked solely because S cannot be found in history

#### Scenario: Security residuals are not auto-overridden

- **WHEN** stale-block resume re-runs review against new HEAD H
- **AND** residual findings include non-allowlisted security keys
- **THEN** the pipeline SHALL NOT invent an `--override` for those keys solely because HEAD moved
- **AND** re-block or needs-human on the new HEAD remains available when policy requires it

#### Scenario: Unreadable head fails closed

- **WHEN** the linked open PR cannot be resolved or the PR HEAD cannot be read during stale-block resume
- **THEN** the pipeline SHALL keep `pipeline:blocked`
- **AND** SHALL NOT clear the block without positive evidence that HEAD moved past S

### Requirement: Advance enter-path SHALL attempt stale-block resume before terminal STOP

When `pipeline single`, durable loop dispatch, or train advance observes `pipeline:blocked` on an item whose stage is resume-eligible (at least pre-merge, fix, and review stages that can re-enter review), the engine SHALL run the stale-block resume evaluation before treating that leftover label as a terminal STOP, surface-only exit, or whole-train abort for that item on the current advance. A successful clear SHALL continue the same advance so pre-merge or review re-enters without requiring a separate operator `unblock`. A keep result (same HEAD, pipeline-internal-only current verdict, or unreadable head) MAY then STOP, hold, or surface the blocker as today.

#### Scenario: Cleared block continues the same advance

- **WHEN** stale-block resume clears `pipeline:blocked` because HEAD superseded the blocking reviewed-sha
- **THEN** the same advance invocation SHALL continue into the stage path (re-fetch labels and enter pre-merge / review work)
- **AND** SHALL NOT require a second human `pipeline unblock` solely to drop the pre-resume label

#### Scenario: Keep result may terminal-STOP after the attempt

- **WHEN** stale-block resume evaluates and returns keep (HEAD still at reviewed-sha, or other keep condition)
- **THEN** train STOP or loop per-item hold after that attempt remains allowed
- **AND** the pipeline SHALL have performed the resume evaluation on that advance before the STOP

#### Scenario: Re-block on new HEAD may terminal-STOP

- **WHEN** stale-block resume cleared the leftover block and re-review on H again sets `pipeline:blocked`
- **THEN** train STOP or loop hold for the new block is correct
- **AND** that STOP is not the pre-resume leftover label without a review attempt at H

### Requirement: Soft composition coverage MAY guard stale-block resume before train STOP

In addition to product stale-block resume contracts, the ship-path composition suite MAY include automated coverage that fails when leftover `pipeline:blocked` with newer non-pipeline-internal HEAD movement past the blocking reviewed-sha causes train or loop to terminal-STOP without one stale-block resume / re-review attempt on that advance. This composition class is soft relative to train-frontier, scratch-only, and independent R2D merge composition: it MAY be waived with an open tracking issue in the composition inventory without blocking those hard classes. When covered, tests SHALL inject deps and SHALL perform zero real network, git, or subprocess calls. Security denylist and true human-authority residual handling SHALL remain unchanged.

#### Scenario: Covered soft class fails on STOP before resume

- **WHEN** the soft composition class is registered with a covering test
- **AND** stale blocked + non-internal HEAD movement conditions hold under the product contract
- **AND** the system under test terminal-STOPs without attempting stale-block resume/re-review
- **THEN** the covering test SHALL fail

#### Scenario: Soft waiver does not weaken hard ship-path composition

- **WHEN** the soft class is waived with an open tracking issue
- **THEN** train-frontier, scratch-only, and independent R2D merge composition tests SHALL still be required
- **AND** security denylist and human-authority classes SHALL remain unweakened
