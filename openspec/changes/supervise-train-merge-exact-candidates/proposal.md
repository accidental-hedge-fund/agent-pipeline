## Why

Train, merge, merge queue, and parked-item recovery each own their own conflict, check, retry, and STOP behavior. Ambiguous merge results and bounded repair exhaustion can leave work ownerless or require a human to reinvoke the command. The same class already has a lifecycle owner: RecoverySupervisor. Train still calls a second one-pass `recover-parked` recoverer instead of reporting observations to that owner.

## What Changes

- Represent train progression and merge as exact-candidate operation adapters under RecoverySupervisor. Train, `pipeline merge`, and `pipeline merge-queue` report typed observations. They do not declare terminal mechanical failure or invent a train-local recovery state machine.
- Share one merge operation invariant across merge and merge queue: precondition, postcondition, GitHub/git observers, candidate binding, and replay rule.
- Persist a stable merge claim that binds repository, base, frozen issue scope, PR, inspected head, and action identity. Observe fresh candidate, base, checks, review, mergeability, and linkage immediately before submission.
- After timeout, crash, or uncertain merge response, observe remote PR state and prove base containment before any replay. A moved head invalidates candidate evidence and derived merge authorization.
- Keep merge side effects exactly-once across crash boundaries. Charge the claim before submission. Reconcile the observer after restart.
- Stop train from invoking `recover-parked` as a second one-pass recoverer. Residual parks, conflicts, check drift, head drift, unknown mergeability, timeout, and uncertain merge response remain RecoverySupervisor-owned recovery episodes.
- Keep operator merge authority on the original typed envelope. Candidate-bound merge authorization is derived only after exact-candidate gates pass and MUST be re-derived after candidate movement. Do not widen authority.
- Continue proven-independent siblings while another item waits or cools. Exclude direct and transitive dependents until prerequisites are proven integrated.
- Keep merge-queue dry-run as the default. Advance, single, and loop still stop at `pipeline:ready-to-deploy` and never merge.

## Capabilities

### New Capabilities

- `supervised-train-merge`: train progression, per-PR merge, and merge-queue drive as RecoverySupervisor-owned exact-candidate operations with a shared merge invariant, durable claims, remote-truth reconciliation, crash-safe exactly-once merge, and independent-sibling continuation.

### Modified Capabilities

- `integrated-train-mode`: train SHALL NOT invoke `recover-parked` as a second recoverer; parks and merge faults remain supervised; independent siblings continue while an item waits or cools; dependents stay excluded until integration is proven.
- `merge-sub-command`: `pipeline merge` is an operation adapter. It reconciles remote merge truth before retry, binds an exact-candidate claim, and leaves conflict, check drift, head drift, unknown mergeability, timeout, and uncertain response under RecoverySupervisor ownership.
- `merge-queue-command`: merge queue shares the merge invariant, claim, and recovery episodes with `pipeline merge`. Dry-run remains the default.
- `merge-queue-repair-hold`: held conflict, check, and repair-exhaustion outcomes remain owned recovery episodes rather than ownerless STOP. Optional repair stays opt-in.
- `merge-authority-boundary`: merge authorization comes only from the original typed authority envelope and is never widened. Candidate-bound merge authorization MUST be re-derived after candidate movement.
- `supervisor-recover-parked`: `recover-parked` remains an operator CLI. Train SHALL NOT auto-invoke it.
- `autonomous-recovery-controller`: train recovery for unpublished commits, scratch, and other deterministic recipes SHALL run as RecoverySupervisor episodes (loop/advance-wave or merge adapter), not as a train-local `recover-parked` pass.

## Impact

- **Reuse first:** extend `core/scripts/stages/merge.ts` (`mergePr` gates, UNKNOWN budget, `--match-head-commit`), `core/scripts/stages/merge-queue.ts` and `merge_queue_hold.ts` (typed holds, optional repair), `core/scripts/stages/train.ts` (`mergeIssuePr`, `observePr`, containment, independent-sibling hold), `core/scripts/stages/ship-supervision.ts` (operation invariant, claim, side-effect certainty, Cooling), `core/scripts/loop/recovery.ts` (recovery episode, strategy cursor), `core/scripts/loop/reconcile.ts` (live observer), and `core/scripts/candidate-integrity.ts` (pre-mutation claim). Do not add a second RecoverySupervisor, train-local recovery state machine, grant schema, or scheduler.
- **Class vs site:** ownerless merge retry, command-local STOP after uncertain merge or repair exhaustion, and train's second `recover-parked` recoverer are one integration-supervision class. Shared merge invariant, claims, observers, and crash fixtures are the class fix. A merge-only mole would miss merge queue and train merge.
- **CLI:** no new public verb. `pipeline train`, `pipeline merge`, `pipeline merge-queue`, and `pipeline recover-parked` remain the surfaces. Merge-queue dry-run stays the default. Advance, single, and loop still never merge.
- **Authority:** operator invocation authorizes the frozen train or merge-queue scope. Candidate-bound merge authorization is derived only after exact-candidate gates pass. A moved head invalidates that derived authorization. `.github/pipeline.yml` still cannot authorize merges.
- **Tests:** hermetic unit tests inject gh/git/observer fakes. Fresh-process crash fixtures cover merge submission before and after the mutation, and response persistence. No real network, git, or subprocess in unit tests.
- **Docs:** keep `CONTEXT.md` terms (RecoverySupervisor, Operation adapter, Operation invariant, Authoritative observer, Side-effect certainty, Recovery episode, Cooling, Exact-candidate recovery, Independent-sibling continuation, Integration candidate). Align CLI and supervisor docs so train no longer auto-invokes `recover-parked`. Run `node scripts/build.mjs` after `core/` edits.
- **Sequencing:** consumes RecoverySupervisor (#1323) as sole lifecycle owner and the #1329 operation-inventory dispositions. Does not reimplement ship-phase supervision (#1331), liveness (#1332), or the fault matrix (#1333).

## Acceptance Criteria

- [ ] Train does not call `recover-parked` (CLI or shared entrypoint) as a second one-pass recoverer. Parked and blocked items remain RecoverySupervisor-owned.
- [ ] `pipeline merge` and `pipeline merge-queue --apply` share one merge operation invariant and the same recovery-episode treatment for conflict, check drift, head drift, unknown mergeability, timeout, and uncertain merge response.
- [ ] Those six fault classes remain owned (active, Cooling, or external-condition wait). They do not become ownerless STOP or require a human to reinvoke the command solely because the process died or the merge response was uncertain.
- [ ] After timeout, crash, or uncertain merge response, the next attempt observes live PR state and proves base containment before any merge replay.
- [ ] A merge claim binds repository, base, frozen issue scope, PR, inspected head, and action identity. Fresh candidate, base, checks, review, mergeability, and linkage are observed immediately before submission.
- [ ] A moved head invalidates candidate evidence and derived merge authorization. The next merge requires a new exact-candidate gate pass.
- [ ] Merge side effects are exactly-once across crash before submission, crash after submission, and crash after response persistence. A completed merge is not replayed.
- [ ] Merge-queue dry-run remains the default and performs no merges.
- [ ] Merge authority comes only from the original typed operator envelope (direct `pipeline merge`, `merge-queue --apply`, or `train --merge`). Authority is never widened by repository config, host retry, or recover-parked.
- [ ] Train continues proven-independent remaining work while another item waits or cools.
- [ ] Direct and transitive dependents stay excluded until their prerequisites are proven integrated (merged and contained in the fetched base).
- [ ] Tests cover crashes before merge submission, after submission, and after response persistence, with injected seams and no real network, git, or subprocess.
- [ ] Advance, single, and loop still stop at `pipeline:ready-to-deploy` and never merge.
- [ ] No second RecoverySupervisor, train-local recovery state machine, grant schema, `auto_merge` config key, or merge stage is introduced.
- [ ] `npm run ci` passes. After `core/` edits, `node scripts/build.mjs --check` passes.
