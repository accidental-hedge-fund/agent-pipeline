## Why

Many brittle states do not raise a useful error: local and remote state disagree, a side effect completed before a timeout, evidence belongs to an old candidate, or a command returns success without satisfying its outcome. Train then throws or parks as human STOP instead of reconciling from the owning system. The 2026-09-01 #1369 dogfood is this class: GitHub squash-merged the issue's PR while the issue was still `pipeline:fix-2`, then contradictory stage labels and a mid-rebase dirty worktree stopped the train.

## What Changes

- Register every supervised mutation with precondition, postcondition, authoritative observer, candidate binding, side-effect identity, safe replay predicate, and reconstruction rule. Reuse the existing five-field invariant shape already declared for delivery stages, merge, and ship; add the three missing fields in place.
- Name authoritative observers for run ownership, issue stage, worktree and candidate identity, commit publication, PR identity and HEAD, checks, reviews, merge containment, release, deployment, and authority validity. Git, forge, CI, release, and deployment facts come from their owning systems. The local ledger records durable intent and history but cannot overrule those authorities.
- Reconcile before retry and after every recovery action. Exit zero with contradictory remote state is not verified completion. A locally failed but remotely completed operation is recognized without replay.
- Candidate movement starts a new epoch and invalidates candidate-bound review, test, decision, and authority evidence.
- An uncertain side effect is observed before replay: proven complete is reconciled forward, proven absent may replay under the same identity, and still-unknown state remains an owned wait or CapabilityRequest. Reconciliation does not perform external repair.
- **BREAKING (supervisor policy):** supersede requirements that route ledger contradictions (`ledger-ahead`, `external-absent`, `identity-mismatch`) directly to a human. State inconsistency remains RecoverySupervisor-owned unless independent typed-request evidence exists.
- Two `pipeline:*` stage labels on one issue SHALL reconcile to one stage from authoritative label history and `STAGES` order. Train SHALL NOT throw `ambiguous pipeline stage labels` and STOP.
- New fault shapes SHALL enter through a violated invariant and observer, not an error-name branch first.

## Capabilities

### New Capabilities

- `operation-invariant-reconciliation`: shared invariant registry, observer catalog, candidate-epoch invalidation, side-effect certainty before replay, reconstruction of durable local state from owning-system truth, and violated-invariant routing without error-name branches. Includes the #1369 dogfood regression (remote squash-merge while pre-ready-to-deploy, mid-rebase SHA drift, contradictory stage labels, partial archive after unfinished rebase).

### Modified Capabilities

- `durable-run-reconciliation`: supersede "route contradictions to a human"; reconstruct or correct durable local state from authoritative truth; treat remote mutation and identity mismatch as supervisor-owned reconcile, not `hold-for-human` or `noop` STOP.
- `issue-stage-adapters`: extend each delivery-stage invariant with side-effect identity, safe replay predicate, and reconstruction rule; adapters observe before local retry.
- `integrated-train-mode`: contradictory `pipeline:*` stage labels reconcile; train does not throw and STOP on that observation.
- `autonomous-recovery-controller`: reconcile after every recovery action; claimed SHA versus on-disk HEAD and unfinished rebase remain owned; `repair_pipeline_item` does not refuse as human STOP solely for that drift.
- `supervised-train-merge`: a forge squash-merge of this issue's own PR by another actor while the issue is still pre-`ready-to-deploy` is a completed remote side effect, not a reason to open a successor PR or rebase squash-contained commits.

## Impact

- **Reuse first:** `DeliveryStageInvariant` / `MERGE_OPERATION_INVARIANT` / `SHIP_PHASE_INVARIANTS` (same five fields), `core/scripts/loop/reconcile.ts` (`ReconcileObserveDeps`, `classifyDrift`, `computeNextAction`), `core/scripts/operation-observation.ts` (`SideEffectCertainty`), `core/scripts/loop/precondition.ts` `pipelineStageFromLabels`, `core/scripts/operation-reliability.ts` `reconcileCompletedSideEffect`. Do not invent a second reconcile engine, observer package, or RecoverySupervisor.
- **Class, not site:** the class is ambiguous external side effects treated as process success or human STOP. A path-local mole at `train.ts` `pipelineStageFromLabels` throw is incomplete without shared invariant/observer/reconcile law.
- **Tests:** injected I/O only. Cover contradictory labels, remote or local drift, stale evidence, remote mutation by another actor, and partial external operations. The #1369 fixture must fail without the fix.
- **Packaging:** `node scripts/build.mjs` after any `core/` edit. `npm run ci` must pass.
- **Sequencing:** consumes RecoverySupervisor (#1323) as sole lifecycle owner. Does not reimplement issue-stage adapters (#1328), command-form inventory (#1329), unique-operation reliability (#1368), or the fault matrix (#1333). #1328 dirty/remotely-advanced worktrees stay on that issue; the #1369 squash-merge + contradictory-label + unfinished-rebase case stays here. #1326 candidate-epoch invalidation consumes this epoch definition.

## Acceptance Criteria

- [ ] Every supervised mutation declares precondition, postcondition, authoritative observer, candidate binding, side-effect identity, safe replay predicate, and reconstruction rule. A delivery stage, merge, or ship phase missing those fields fails a contract test.
- [ ] A process exit 0 with contradictory remote state is not verified completion and does not replay the mutation.
- [ ] A locally failed attempt whose observer proves the postcondition complete is reconciled forward without replay.
- [ ] Candidate SHA or epoch movement invalidates candidate-bound review, test, decision, and authority evidence for the prior epoch.
- [ ] Durable local ledger, claim, and worktree identity can be corrected or reconstructed from git, forge, CI, release, or deployment truth. The local ledger cannot overrule those authorities.
- [ ] An uncertain side effect is observed before retry: known complete advances without replay; known absent may replay under the same identity; still unknown stays Cooling, external-condition wait, or CapabilityRequest. Reconciliation performs no merge, push, label write, PR edit, release, or deploy as repair.
- [ ] `ledger-ahead`, `external-absent`, and `identity-mismatch` remain RecoverySupervisor-owned. They do not project `hold-for-human` or train STOP unless independent typed-request evidence exists.
- [ ] Two `pipeline:*` stage labels on one issue reconcile to one stage. Train does not throw `ambiguous pipeline stage labels`.
- [ ] A forge squash-merge of this issue's own PR while the issue is still pre-`ready-to-deploy` is recognized as remote mutation. The engine does not open a successor PR on the same branch or rebase squash-contained commits onto that merge.
- [ ] Claimed candidate SHA ≠ on-disk HEAD, including a worktree mid-rebase with staged product dirt, is observed as local/remote drift. Unfinished rebase is not treated as a completed archive candidate. The OpenSpec dirty-before-archive fail-closed remains.
- [ ] A first archive pass that succeeded, followed by a later archive on the same worktree that sees dirt from an unfinished rebase, is a partial external operation: the completed archive is not replayed; the unfinished rebase is observed first.
- [ ] Tests cover contradictory labels, remote or local drift, stale evidence, remote mutation by another actor, and partial external operations. The #1369 fixture fails without the reconcile law.
- [ ] A new fault shape can enter through a violated invariant and observer without adding an error-name branch first. A fixture that switches on a thrown message such as `ambiguous pipeline stage labels` fails the class guard.
- [ ] `npm run ci` passes.
