## 1. Shared merge invariant and claims

- [x] 1.1 Add a merge-supervision module beside `merge.ts` that declares the shared merge operation invariant (precondition, postcondition, GitHub/git observer, candidate binding, replay rule) and verify a unit test round-trips those fields without treating process exit as completion
- [x] 1.2 Persist an exact-candidate merge claim (repository, base, frozen issue scope, PR, inspected head, action identity) before `ghPrMerge`, and verify a unit test fails if merge is submitted without that claim
- [x] 1.3 Observe mergeability, checks, review currency, linkage, and head immediately before submission, and verify the claim binds the MERGEABLE+CLEAN head SHA rather than an earlier UNKNOWN read
- [x] 1.4 Keep `pipeline merge` as the compatibility adapter over RecoverySupervisor observations (no second controller or ledger family), and verify standalone `pipeline merge` still runs the existing gates

## 2. Reconcile, exactly-once, and owned faults

- [x] 2.1 Reconcile live PR merge state and fetched-base containment before any merge replay, and verify an already-merged contained PR does not call `ghPrMerge` a second time
- [x] 2.2 Map timeout, crash, and unreadable merge response to side-effect certainty `uncertain`, and verify the next attempt observes before replay
- [x] 2.3 Invalidate the claim and derived merge authorization when head, base, PR, or frozen issue scope moves, and verify a stale-head fixture refuses merge under the old claim
- [x] 2.4 Keep conflict, check drift, head drift, unknown mergeability, timeout, and uncertain merge response owned (Cooling or wait) for supervised callers, and verify those paths do not become ownerless STOP
- [x] 2.5 Keep standalone `pipeline merge` operator non-zero exit for gate failure, and verify train/merge-queue consume the observation without treating that exit as ownerless terminal

## 3. Merge queue shares the adapter

- [x] 3.1 Route merge-queue `--apply` through the shared merge adapter (same invariant, claim, and recovery episodes), and verify a unit test fails if apply uses a looser mergeability or checks rule than `mergePr`
- [x] 3.2 Keep merge-queue dry-run as the default with zero merge claims or mutations, and verify default invocation does not call `ghPrMerge`
- [x] 3.3 Treat merge-queue repair-budget exhaustion as owned Cooling/wait rather than human authority, and verify remaining candidates still continue

## 4. Train drops the second recoverer

- [x] 4.1 Remove production `recoverParked` wiring from train, and verify a hermetic test fails if production train deps call `recover-parked`
- [x] 4.2 Report train park, block, and merge-fault observations to RecoverySupervisor, and verify train does not invent override or drop `blocked`/`needs-human` itself
- [x] 4.3 Keep loop/advance-wave recovery as the in-wave recoverer for unpublished publish, scratch unlink, and related recipes, and verify the unpublished-commit recipe still runs for train without a train-local recover-parked pass
- [x] 4.4 Map Cooling/wait onto the existing contained-hold path so proven-independent siblings continue, and verify a fixture that STOPs with `will not implement another sibling` during Cooling fails
- [x] 4.5 Keep direct and transitive dependents excluded until prerequisite merge-result containment, and verify a dependent-advance-while-cooling fixture fails

## 5. Fresh-process crash coverage

- [x] 5.1 Add an injected crash-before-submission fixture, and verify the next process does not merge until gates re-prove the same inspected head and the operation stays owned
- [x] 5.2 Add an injected crash-after-submission fixture, and verify the next process observes PR state and containment and does not submit a second merge when the postcondition is proven
- [x] 5.3 Add an injected crash-after-response-persistence fixture, and verify a known-complete claim is not replayed
- [x] 5.4 Confirm crash tests perform no real network, git, or subprocess, and verify they fail if those I/O seams are used

## 6. Authority, docs, packaging, and CI

- [x] 6.1 Keep merge authority on the original operator envelope (`pipeline merge`, `merge-queue --apply`, `train --merge`) and never from config, recover-parked, or host retry, and verify a fixture that grants merge from `.github/pipeline.yml` or recover-parked fails
- [x] 6.2 Align `CONTEXT.md`, CLI docs, and `docs/supervisor.md` so train no longer auto-invokes `recover-parked`, and verify those surfaces still name recover-parked as an operator CLI
- [x] 6.3 After any `core/` edit run `node scripts/build.mjs` and verify `node scripts/build.mjs --check` passes
- [x] 6.4 Run `openspec validate supervise-train-merge-exact-candidates` and `openspec validate --all`, and verify both exit 0
- [x] 6.5 Run `npm run ci` from the repo root, and verify the full gate passes
