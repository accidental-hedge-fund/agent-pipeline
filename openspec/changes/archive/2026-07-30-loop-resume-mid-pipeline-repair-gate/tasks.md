## 1. Pure mid-flight stage classification

- [x] 1.1 Add pure `isMidFlightPipelineStage(stage: string | null): boolean` derived from `STAGES` in `core/scripts/types.ts`, colocated with `loop/precondition.ts` (or exported from there for reconcile use)
- [x] 1.2 Encode Decision 2 membership: mid-flight = known active advance stages; **not** mid-flight for `null`, `backlog`, `ready`, `ready-to-deploy`, `needs-human`; unknown non-null → mid-flight
- [x] 1.3 Unit-test the helper table (`fix-2`, `review-1`, `pre-merge`, `implementing`, `planning`, `design-gate`, `visual-gate`, `ready-to-deploy`, `ready`, `backlog`, `needs-human`, `null`, unknown string) with no I/O

## 2. Gate repair-forward in reconcile

- [x] 2.1 Update `verifiedForwardTarget` and/or `classifyDrift` so local ledger states + open PR + mid-flight `pipeline_stage` do **not** produce `ledger-behind` / do **not** target `pr_opened`
- [x] 2.2 Preserve precedence: `merged` and `ready_label_present` win over the mid-flight open-PR gate
- [x] 2.3 Preserve #511 crash-after-PR-open: local + open PR + **non-mid-flight / null** stage still repair-forwards to `pr_opened`
- [x] 2.4 Ensure checks conclusion (`success` / `failure` / `pending` / absent) never overrides the mid-flight gate
- [x] 2.5 Adjust #511 local+open-PR tests: mid-flight cases assert no demotion; non-mid-flight cases keep catch-up to `pr_opened`

## 3. Required legacy heal: stranded `pr_opened` → `in_progress`

- [x] 3.1 When ledger is `pr_opened`, identity has open PR, and `pipeline_stage` is mid-flight, restore to `in_progress` with an audited history note (and event) so the supervisor re-dispatches
- [x] 3.2 Heal must not apply when stage is `ready-to-deploy` / `needs-human` / non-mid-flight, or when PR is merged / ready label present (those use ready/merged catch-up)
- [x] 3.3 Idempotence: second reconcile with same identity leaves `in_progress` without oscillating back to `pr_opened` or emitting duplicate heal spam
- [x] 3.4 After heal (or gate), mid-flight continuity must not depend solely on non-consuming `next_actions.advance` on `pr_opened`
- [x] 3.5 Heal must not be gated on `!driftClass`: stranded `pr_opened` with stale `last_verified_identity` (head SHA / checks churn → `identity-mismatch` or `checks-regressed`) still restores to `in_progress`; drift remains recorded; identity is updated

## 4. Supervisor resume re-dispatch (execution-trace tests)

- [x] 4.1 Confirm supervisor cycle still re-dispatches all `in_progress` items before selecting new `pending` work (existing `runSupervisorCycle` ordering)
- [x] 4.2 Supervisor regression: resume/dead-lock recovery → reconcile leaves mid-flight item `in_progress` → `dispatchItem` is invoked for that item; assert call trace, not only ledger state
- [x] 4.3 Sibling ordering: active mid-flight `in_progress` item + pending sibling → execution seam called for the active item (must not only dispatch the sibling because reconcile demoted the active one)
- [x] 4.4 Healed `pr_opened` → `in_progress` path: after reconcile heal, subsequent cycle re-dispatches via `pipeline/loop-execution@1`
- [x] 4.5 Re-dispatch continues from live stage labels (existing advance resume behavior); no new "restart from ready" transition

## 5. Regression tests that bite

- [x] 5.1 Pure: `classifyDrift(in_progress, open PR, fix-2, checks success)` is **not** `ledger-behind`; fails without gate
- [x] 5.2 Reconcile: `in_progress` + open PR + green checks + `pipeline_stage: fix-2` remains `in_progress`, not `pr_opened`
- [x] 5.3 Reconcile: `pending` + open PR + mid-flight stage stays `pending`
- [x] 5.4 Reconcile: local + merged still → `merged`; local + ready label still → `ready`
- [x] 5.5 Compatibility: local + open PR + `pipeline_stage: null` (or `ready`) still → `pr_opened` (#511)
- [x] 5.6 Checks matrix on mid-flight local open PR: success / failure / pending / absent all leave local state (no stranding at `pr_opened`)
- [x] 5.7 Heal: `pr_opened` + mid-flight open PR → `in_progress`; second pass stable
- [x] 5.8 Multi-item: item A mid-flight `in_progress` + item B `pending` after reconcile → A still dispatchable
- [x] 5.9 All new tests use injected observe/store/supervisor fakes only — no real network, git, or subprocess

## 6. OpenSpec deltas, mirror, CI

- [x] 6.1 Keep requirement/scenario deltas under `openspec/changes/loop-resume-mid-pipeline-repair-gate/specs/` only; do **not** edit living `openspec/specs/` during implementation
- [x] 6.2 Update delta specs for required heal, mid-flight predicate, #511 compatibility, and supervisor execution-trace requirements if still incomplete
- [x] 6.3 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit
- [x] 6.4 Run targeted tests (`loop-reconcile`, `loop-supervisor`, mid-flight helper), then `npm run ci` until green
- [x] 6.5 `openspec validate loop-resume-mid-pipeline-repair-gate` and `openspec validate --all` (via CI) pass
