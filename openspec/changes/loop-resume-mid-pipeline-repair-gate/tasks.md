## 1. Pure mid-flight stage classification

- [ ] 1.1 Add a pure helper (e.g. `isMidFlightPipelineStage`) that classifies `LoopExternalIdentity.pipeline_stage` as mid-flight advance work vs pre-pipeline / terminal (`ready-to-deploy`), colocated with or adjacent to `loop/precondition.ts` / `loop/reconcile.ts`
- [ ] 1.2 Unit-test the helper for representative stages (`fix-2`, `review-1`, `pre-merge`, `implementing`, `planning`, `ready-to-deploy`, `ready`, `backlog`, `null`) with no I/O

## 2. Gate repair-forward in reconcile

- [ ] 2.1 Update `verifiedForwardTarget` and/or `classifyDrift` so local ledger states + open PR + mid-flight `pipeline_stage` do **not** produce `ledger-behind` / do **not** target `pr_opened`
- [ ] 2.2 Preserve forward repair to `merged` when `pr_state === "merged"` from local states
- [ ] 2.3 Preserve forward repair to `ready` when `ready_label_present` from local states
- [ ] 2.4 Ensure open PR alone no longer strands mid-flight work at `pr_opened` even when `checks_conclusion === "success"`
- [ ] 2.5 Adjust or replace the #511 local+open-PR ⇒ `ledger-behind` test so it encodes mid-flight continuity (re-dispatch local state) rather than demotion to `pr_opened`

## 3. Residual stranded pr_opened heal (preferred in-scope)

- [ ] 3.1 When ledger is already `pr_opened`, identity has open PR, and `pipeline_stage` is mid-flight, restore the item to `in_progress` via an audited history note (or equivalent) so the supervisor re-dispatches it
- [ ] 3.2 Ensure the heal does not apply when stage is `ready-to-deploy` or PR is merged (those use ready/merged catch-up)
- [ ] 3.3 Keep `computeNextAction` from advertising non-consuming `advance` as the sole continuation path for mid-flight items covered by the gate/heal

## 4. Supervisor resume path verification

- [ ] 4.1 Confirm supervisor cycle still re-dispatches all `in_progress` items before selecting new `pending` work (no regression)
- [ ] 4.2 Add or extend a supervisor-level unit test (injected seams): after reconcile of `in_progress` + mid-flight open PR + green checks, the item is re-dispatched and not skipped for a sibling `pending` item
- [ ] 4.3 Cover healed `pr_opened` → `in_progress` re-dispatch if the heal path is implemented

## 5. Regression tests that bite

- [ ] 5.1 Pure/unit test: ledger `in_progress` + open PR + checks success + `pipeline_stage: fix-2` → after `reconcile`, state remains dispatchable (`in_progress`, not `pr_opened`)
- [ ] 5.2 Pure/unit test: `pending` + open PR + mid-flight stage → not repaired to stranded `pr_opened`
- [ ] 5.3 Pure/unit test: local + merged PR still repairs to `merged`; local + ready label still repairs to `ready`
- [ ] 5.4 Prove at least one mid-flight regression fails without the gate (document or temporarily demonstrate against pre-fix behavior)
- [ ] 5.5 All new tests use injected observe/store fakes only — no real network, git, or subprocess

## 6. Mirror, CI, and OpenSpec

- [ ] 6.1 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit
- [ ] 6.2 Run `npm run ci` from repo root and fix failures until green
- [ ] 6.3 Run `openspec validate loop-resume-mid-pipeline-repair-gate` (and `openspec validate --all` via CI) and keep the change structurally valid
