## Why

A resumed issue can stay at `pipeline:visual-gate` and reach `pipeline:ready-to-deploy` after a non-pipeline-internal commit moves the linked PR head past the SHA that review-1/review-2 approved. The pre-merge SHA gate catches movement while it is executing, and stale-block recovery catches some leftover `pipeline:blocked` cases, but an unblocked later-stage resume does not revalidate review currency before dispatch.

Live dogfood: v1.40.1 recovery of #1459. Review approved `019e7862`. Pre-merge added internal archive commit `132dac30`. A developer assertion commit then moved HEAD to `4c052bb1`. Direct resume started at visual-gate and reached ready-to-deploy without rerunning review. Operators demoted the issue and forced exact-SHA review by hand. This class of later-stage fail-open must not need a new mole issue.

## What Changes

- Before dispatch of any later stage after review (`visual-gate`, `eval-gate`, `shipcheck-gate`, `ready-to-deploy`), reconcile the linked PR HEAD against the latest authoritative review evidence using the existing review-SHA currency surface (`resolveReviewedShaCurrency` / `reconcileReviewCurrency`).
- A non-pipeline-internal HEAD change starts a new candidate epoch. It invalidates candidate-bound review, test, and readiness evidence for the prior SHA. It atomically returns the issue to `review-1` before any later gate can run. Exact-SHA review of the new HEAD is required.
- Pipeline-internal-only commits keep the existing documented reuse behavior (`isPipelineInternalCommit` / #98). They do not start a new epoch and do not force re-review.
- The guard applies to ordinary advance, nested/single/loop recovery, and already-blocked or unblocked resumed issues. Stale-block resume is not the only enter path.
- Recovery MUST NOT classify an actionable review-stage item as noop solely from pending checks or a stale prior failure episode after the candidate epoch changes.
- Hermetic regression tests reproduce the visual-gate-to-ready fail-open and prove exact-SHA review is required after developer movement.
- No merge or release authority change. Advance, single, and loop still never merge.

## Capabilities

### New Capabilities

- (none) — the holding rung is the existing review-SHA currency reconcile plus dispatch and recovery call sites. Do not add a second SHA-gate product.

### Modified Capabilities

- `review-sha-gating`: Later-stage dispatch SHALL reconcile PR HEAD against the latest review evidence before the later stage runs. A superseded (non-pipeline-internal) HEAD SHALL start a new candidate epoch, invalidate candidate-bound review/test/readiness evidence, and atomically return the issue to `review-1`. Pipeline-internal-only movement SHALL keep existing reuse. Observation failure SHALL fail closed.
- `reconcile-and-converge`: Later-stage resume SHALL consume the same review-currency reconcile outputs as the pre-merge SHA gate. It SHALL NOT invent a stage-local reuse or skip rule.
- `stale-blocked-rereview`: Enter-path coverage SHALL include unblocked later-stage resumes, not only leftover `pipeline:blocked` at pre-merge/fix/review. Nested, single, loop, and ordinary advance SHALL share that enter path.
- `recovery-episodes`: After a new candidate epoch, RecoverySupervisor SHALL NOT classify an actionable review-stage item as noop solely from pending checks or a stale prior failure episode bound to the previous epoch.
- `candidate-integrity`: A non-pipeline-internal HEAD change after review SHALL invalidate prior-SHA review, test, and readiness evidence as authority for later gates and ready-to-deploy. Exact-SHA match and pipeline-internal-only exemptions on an unchanged-authority head remain unchanged.

## Acceptance criteria

- [ ] Before dispatch of `visual-gate`, `eval-gate`, `shipcheck-gate`, or `ready-to-deploy`, the engine reconciles the linked PR HEAD against the latest authoritative review SHA using the shared currency helper.
- [ ] Fixture: review approved SHA S, then a non-pipeline-internal commit lands at H, issue label is `pipeline:visual-gate` (unblocked). Next advance does not run visual-gate or reach `pipeline:ready-to-deploy`. It transitions to `review-1` in the same invocation and requires a review bound to H.
- [ ] Fixture: the same HEAD movement at `eval-gate`, `shipcheck-gate`, or `ready-to-deploy` also returns to `review-1` before that later stage runs.
- [ ] Fixture: only pipeline-internal commits after S (`chore: archive OpenSpec change(s) for #…` or exact visual-publish subject). Later-stage resume proceeds. It does not force re-review and does not start a new epoch.
- [ ] Fixture: PR HEAD or commit list cannot be read. Later stage does not run. The path fails closed.
- [ ] Nested whole-item advance, `pipeline single`, durable loop recovery, and ordinary `runAdvance` all hit the same guard. A leftover `pipeline:blocked` is not required for the guard to run.
- [ ] After epoch change, recovery does not classify an actionable `review-1`/`review-2` item as noop solely because checks are pending or because a prior failure episode existed on S.
- [ ] Unit tests inject deps (no real network, git, or subprocess). The visual-gate-to-ready fail-open fixture fails without the guard. After any `core/` edit, host SKILLs are refreshed. `openspec validate invalidate-later-stage-resume` and `npm run ci` pass when implementation lands.

## Impact

- `core/scripts/pipeline-run.ts` — dispatch-time later-stage review-currency guard before visual/eval/shipcheck/ready-to-deploy (and nested/single/loop paths that share `runAdvance`).
- Existing `resolveReviewedShaCurrency` / `reconcileReviewCurrency` / `reconcileReviewShaGateState` — reuse, not a second classifier.
- `core/scripts/stages/stale-blocked-rereview.ts` — keep blocked-enter coverage; later-stage unblocked resume is the shared dispatch guard, not a visual-gate-only mole.
- RecoverySupervisor / Recovery Episode next-action — epoch-scoped noop classification for review-stage items.
- Tests: new hermetic later-stage resume regressions plus existing SHA-gate and stale-block fixtures that must keep #98 reuse.
- Generated host SKILLs after any `core/` edit (`node scripts/build.mjs`).
- Out of scope: merge/release authority; advance/single/loop still never merge; no new `auto_merge` key; no weakening of same-head residual blocking keys.
