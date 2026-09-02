## Why

Planning, implementation, review, fix, validation gates, pre-merge preparation, worktree handling, auto-recovery, and `recover-parked` still own overlapping retry and terminalization. Fixing one site at a time keeps the same class of failure: a stage or legacy controller chooses lifecycle treatment and can end ownership. Issue advancement must report observations to RecoverySupervisor, which already owns merge, ship, and command-form supervision.

## What Changes

- Convert every issue-advancement stage into a typed operation adapter. The adapter performs one bounded attempt, declares its invariants, and reports an observation with evidence. It does not choose Cooling, wait, typed request, cancellation, or a terminal mechanical outcome.
- Limit stage-local loops to bounded transport retry. Transport retry is allowed only when the operation is proven idempotent, the side effect is known absent, and the retry stays inside the attempt deadline. Candidate movement, ambiguity, treatment changes, cooling, and re-entry belong to RecoverySupervisor.
- Turn `auto_recover` and `recover-parked` into compatibility entrypoints that claim or resume the same Recovery Episode. They keep no independent budgets and no independent terminal outcomes.
- Consolidate missing, stale, dirty, occupied, and remotely advanced workspaces behind the existing `ensureManagedWorktree` materialization seam. Pipeline-owned scratch may be removed. Unknown work is preserved and reported as inconsistency. Unknown work is never deleted.
- Invalidate candidate-bound review, test, decision, and authority evidence when the candidate epoch changes.
- Treat harness crash, malformed output, no-op, and non-convergence as observations that advance RecoverySupervisor treatment or Cooling. They do not become stage-local terminals.
- Give every former issue-stage blocking site an explicit migrated outcome. Keep tests, review, OpenSpec, visual, eval, and shipcheck gates fully enforced.

## Capabilities

### New Capabilities

- `issue-stage-adapters`: issue-advancement stages as RecoverySupervisor operation adapters; declared invariants; universal fault ingress; bounded transport retry only; candidate-epoch evidence invalidation; harness crash / malformed output / no-op / non-convergence observations; migrated-outcome inventory for former blocking sites; quality-gate enforcement after migration.

### Modified Capabilities

- `autonomous-recovery-controller`: `auto_recover` becomes a compatibility adapter or recovery strategy. It no longer owns independent retry budgets or terminal outcomes.
- `supervisor-recover-parked`: `recover-parked` becomes a compatibility entrypoint that claims or resumes the same Recovery Episode. It keeps its public CLI and override-eligibility rules. It does not keep an independent controller budget or terminal outcome.
- `worktree-rematerialize`: missing, stale, dirty, occupied, and remotely advanced workspaces enter one shared materialization recovery. Stage handlers report observations. They do not choose lifecycle treatment for those faults.
- `engine-scratch-recover`: pipeline-owned scratch remains deterministic unlink. Unknown dirt is preserved or quarantined and reported as inconsistency. Unknown dirt is never deleted.
- `fix-harness-crash-retry`: a failed harness invocation is an operation observation. RecoverySupervisor owns treatment and Cooling. The fix stage does not keep a stage-local lifecycle retry-then-block loop.
- `noop-advance-contract`: a clean no-new-commit with an unsatisfied goal is an observation. RecoverySupervisor owns treatment. The stage does not terminalize the Logical Operation.
- `stage-output-contract`: malformed or contract-failing harness output remains a gated side-effect refusal and becomes an operation observation. The adapter does not declare the run terminal.
- `escalation-site-dispositions`: every former issue-stage blocking site records an explicit migrated outcome (observation, Cooling, wait, typed request, compatibility projection, or authenticated cancellation).
- `blocked-recovery-recipes`: `setBlocked` remains a lifecycle projector. It does not choose RecoverySupervisor treatment or end ownership.
- `stage-attempt-ledger`: Recovery Episode treatment history reuses this ledger and the existing operation-claim records. Stages do not keep a second terminalizing budget book.
- `pipeline-state-machine`: issue-stage dispatch remains the ordered `STAGES` spine. Stage handlers are adapters. A blocked/waiting/no-op projection does not end RecoverySupervisor ownership.

## Impact

- **Class vs site:** stage-local retry, `setBlocked` as policy, `auto_recover` as a second controller, `recover-parked` as a second controller, and per-stage worktree recovery are one class: issue-advancement surfaces that bypass RecoverySupervisor. The class fix is universal fault ingress, declared invariants, one materialization capability, and compatibility adapters that share one Recovery Episode. A mole on one stage (for example only fix crash retry, or only missing-worktree rematerialize) is incomplete.
- **Reuse first:** extend `operation-observation.ts` (`defaultRecoverySupervisorReport`, claims, `mechanicalFaultObservation`) and the merge/ship adapter pattern in `merge-supervision.ts` / `ship-supervision.ts`. Extend `ensureManagedWorktree` and `classifyWorktreeDirt`. Reuse `stage-attempt-ledger` and autonomous-recovery recipes as RecoverySupervisor treatments. Do not add a second RecoverySupervisor, a second worktree subsystem, a third attempt ledger, or a public supervisor CLI verb.
- **CLI:** no new public verb. `pipeline recover-parked` stays an operator CLI. `auto_recover` stays an internal compatibility entry. Advance, single, and loop still never merge.
- **Sequencing:** consumes RecoverySupervisor (#1323) as sole lifecycle owner. Follows numeric-drive durable supervision (#1327) as invocation context. Does not reimplement command-form inventory (#1329), train/merge exactness (#1330), ship phases (#1331), liveness (#1332), or the fault matrix (#1333).
- **Tests:** hermetic unit tests inject gh/harness/worktree fakes. Contract tests fail when an issue stage lacks an adapter/invariant, when a stage-local loop applies lifecycle policy, when `auto_recover` or `recover-parked` keeps an independent budget or terminal, when unknown dirt is deleted, or when a former blocking site has no migrated outcome. No real network, git, or subprocess in unit tests.
- **Docs:** keep CONTEXT.md RecoverySupervisor vocabulary. Align living specs. Run `node scripts/build.mjs` after any later `core/` edit. This planning change does not edit application code.

## Acceptance Criteria

- [ ] Every issue-advancement stage (`planning`, `plan-review`, `pre-code-attestation`, `implementing`, `design-gate`, `review-1`, `fix-1`, `review-2`, `fix-2`, `pre-merge`, `visual-gate`, `eval-gate`, `shipcheck-gate`, `ready-to-deploy`) reports a typed operation observation through the existing RecoverySupervisor observation sink and declares its relevant operation invariants.
- [ ] A stage adapter fixture that chooses Cooling, wait, typed request, cancellation, or a terminal mechanical outcome fails a contract test.
- [ ] Stage-local retry is proven only for transport errors where the operation is idempotent, the side effect is known absent, and the retry stays inside the attempt deadline. A fixture that retries after candidate movement, uncertain side effects, or treatment changes fails.
- [ ] `auto_recover` claims or resumes the same Recovery Episode as the owning advance operation. A fixture that spends a private `auto_recovery_max_retries` budget or posts a terminal auto-recovery-limit outcome without RecoverySupervisor ownership fails.
- [ ] `pipeline recover-parked` claims or resumes that same Recovery Episode. A fixture that applies an independent fingerprint-terminal or ownerless stop without RecoverySupervisor ownership fails. Override-eligibility for HIGH/CRITICAL/security/authority remains fail-closed.
- [ ] Missing, stale, dirty, occupied, and remotely advanced workspaces enter `ensureManagedWorktree` (or a thin facade over it). A stage-local rematerialize/block path that bypasses that seam fails a contract test.
- [ ] Pipeline-owned scratch is unlinked or restored by the shared classifier. Unknown or unclassified dirt is preserved or quarantined, reported as inconsistency, and never deleted.
- [ ] Replacing the candidate identity starts a new candidate epoch and invalidates candidate-bound review, test, decision, and authority evidence. A fixture that reuses a prior-epoch verdict, gate result, decision, or authority hold fails.
- [ ] Harness crash, malformed output, no-op with unsatisfied goal, and review non-convergence emit observations that leave the Logical Operation owned. RecoverySupervisor may cool or change treatment. The adapter does not mark the operation complete, cancelled, or human-owned.
- [ ] Every former issue-stage `setBlocked` / `needs-human` / off-ramp site in the escalation inventory has an explicit migrated outcome. A new issue-stage emitter without a migrated-outcome row fails the drift guard.
- [ ] Tests, review, OpenSpec, visual, eval, and shipcheck gates still run and can still refuse advancement. Migration does not skip, default-disable, or demote those gates.
- [ ] Tests inject all external I/O. `npm run ci` passes.
- [ ] No second RecoverySupervisor, worktree subsystem, attempt ledger, grant schema, merge stage, or public supervisor CLI verb is introduced.
