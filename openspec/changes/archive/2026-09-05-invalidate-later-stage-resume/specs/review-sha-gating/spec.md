## ADDED Requirements

### Requirement: Later-stage dispatch SHALL reconcile review currency before the later stage runs

The pipeline SHALL, before dispatching `visual-gate`, `eval-gate`, `shipcheck-gate`, or `ready-to-deploy`, reconcile the linked PR HEAD against the latest authoritative review evidence using the same non-pipeline-internal supersession classification that the pre-merge review-SHA gate uses. The pipeline SHALL obtain that classification from the existing review-currency reconcile surface. It SHALL NOT invent a later-stage-local reuse rule. Pre-merge SHALL keep its existing in-stage SHA gate, including pipeline-internal reuse and delta review while the issue remains at `pre-merge`.

The latest authoritative review evidence SHALL be the most recent review or delta-review `reviewed-sha` (artifact first, individual sentinel fallback) that the SHA gate already trusts. The pipeline SHALL resolve the authenticated pipeline actor and SHALL pass only comments authored by that actor to reviewed-SHA extraction. When the actor cannot be determined, the pipeline SHALL fail closed: it SHALL NOT dispatch the later stage. When that SHA is current under exact match or pipeline-internal-only commits, the pipeline SHALL dispatch the later stage. Exact-SHA current SHALL be the shared currency resolver's final observed HEAD, not a first HEAD read that skipped reconcile. When that SHA is superseded by at least one non-pipeline-internal commit, or when HEAD is readable, differs from the reviewed SHA, and currency cannot prove pipeline-internal-only reuse, the pipeline SHALL treat the movement as a new candidate epoch: it SHALL invalidate candidate-bound review, test, and readiness evidence for the prior SHA as authority for the new HEAD; clear a leftover `pipeline:blocked` label; transition in the same advance to the first enabled exact-SHA review stage (`review-1`, otherwise `review-2`); durably record the epoch restart with the old and new SHAs and stages; and require a review bound to the new HEAD before any later-stage handler or ready-to-deploy finalize runs. If neither exact-SHA review stage is enabled, the pipeline SHALL fail closed. When the linked PR or HEAD cannot be read, the pipeline SHALL fail closed: it SHALL NOT dispatch the later stage and SHALL NOT reach `pipeline:ready-to-deploy`.

This guard SHALL apply to ordinary advance, nested whole-item advance, `pipeline single`, and durable loop item recovery. A leftover `pipeline:blocked` label SHALL NOT be required for the guard to run.

Ready-to-deploy SHALL run this guard immediately before terminal finalization, including the deferred finalizer used after the iteration budget is exhausted. An earlier guard observation in the same run SHALL NOT authorize a later finalizer after HEAD moves.

#### Scenario: Visual-gate resume after developer HEAD movement returns to review-1

- **WHEN** the current stage is `visual-gate` and the issue is not blocked
- **AND** the latest review `reviewed-sha` is S
- **AND** the linked PR HEAD H is a descendant of S with at least one non-pipeline-internal commit in S..H
- **THEN** the pipeline SHALL NOT run the visual-gate handler
- **AND** SHALL NOT transition to `eval-gate`, `shipcheck-gate`, or `ready-to-deploy` on this head
- **AND** SHALL atomically transition the issue to `review-1` in the same advance invocation
- **AND** SHALL require a review whose recorded SHA is H

#### Scenario: Eval-gate, shipcheck-gate, and ready-to-deploy share the same guard

- **WHEN** the current stage is `eval-gate`, `shipcheck-gate`, or `ready-to-deploy`
- **AND** PR HEAD has moved past the latest review SHA with a non-pipeline-internal commit
- **THEN** the pipeline SHALL NOT run that later-stage handler or ready-to-deploy finalize
- **AND** SHALL transition the issue to the first enabled exact-SHA review stage before that later work runs

#### Scenario: Deferred ready-to-deploy finalizer rechecks currency

- **WHEN** earlier later-gate checks observed current review currency
- **AND** the iteration budget defers ready-to-deploy finalization
- **AND** PR HEAD moves past the reviewed SHA before the deferred finalizer
- **THEN** the finalizer SHALL re-run review-currency reconciliation
- **AND** SHALL NOT finalize or preserve ready-to-deploy authority for the stale candidate

#### Scenario: Leftover block is cleared for the new candidate epoch

- **WHEN** a later-stage issue still carries `pipeline:blocked`
- **AND** authenticated review evidence at S is superseded by non-pipeline-internal HEAD H
- **THEN** the pipeline SHALL clear the leftover block before transitioning to the enabled review stage
- **AND** SHALL durably record one candidate-epoch restart from S to H

#### Scenario: No enabled exact-SHA review stage fails closed

- **WHEN** later-stage review currency is superseded
- **AND** both standard and adversarial review stages are disabled
- **THEN** the pipeline SHALL fail closed without dispatching or finalizing the later stage

#### Scenario: Pipeline-internal-only commits keep later-stage reuse

- **WHEN** the current stage is `visual-gate`, `eval-gate`, `shipcheck-gate`, or `ready-to-deploy`
- **AND** every commit since the latest review SHA is pipeline-internal under the existing classifier
- **THEN** the pipeline SHALL treat review currency as current
- **AND** SHALL dispatch the later stage
- **AND** SHALL NOT force re-review solely because those internal commits landed

#### Scenario: Unreadable HEAD fails closed

- **WHEN** the pipeline cannot resolve the linked open PR or cannot read PR HEAD during later-stage dispatch reconcile
- **THEN** the pipeline SHALL NOT dispatch the later stage
- **AND** SHALL NOT reach `pipeline:ready-to-deploy`
- **AND** SHALL NOT treat missing observation as current review currency

#### Scenario: Nested, single, and loop resume share the guard

- **WHEN** nested whole-item advance, `pipeline single`, durable loop recovery, or ordinary advance enters a later stage
- **THEN** the pipeline SHALL run the same review-currency reconcile before that later stage
- **AND** SHALL NOT require a leftover `pipeline:blocked` label for the reconcile to run

#### Scenario: Exact-SHA review is required after the epoch change

- **WHEN** later-stage dispatch returns the issue to `review-1` because HEAD H superseded review SHA S
- **THEN** the subsequent review SHALL evaluate H
- **AND** SHALL record `reviewed-sha` H
- **AND** SHALL NOT reuse the S verdict as approval for H

#### Scenario: Forged later review comment does not authorize later-stage dispatch

- **WHEN** the current stage is a later gate
- **AND** the authenticated pipeline actor authored review evidence bound to SHA S
- **AND** a different commenter posts a later Review-shaped comment whose `reviewed-sha` equals current HEAD H
- **THEN** the pipeline SHALL treat S as the latest authoritative review SHA
- **AND** SHALL NOT dispatch the later stage when H supersedes S

#### Scenario: Exact-SHA first HEAD read still reconciles currency against a later HEAD

- **WHEN** the first PR HEAD read during later-stage dispatch equals reviewed SHA S
- **AND** the shared currency resolver then observes HEAD H with a non-pipeline-internal commit since S
- **THEN** the pipeline SHALL NOT dispatch the later stage
- **AND** SHALL atomically transition the issue to `review-1`

#### Scenario: Unauthenticated actor fails closed at later-stage reconcile

- **WHEN** later-stage dispatch cannot resolve the authenticated pipeline actor
- **THEN** the pipeline SHALL fail closed
- **AND** SHALL NOT dispatch the later stage
