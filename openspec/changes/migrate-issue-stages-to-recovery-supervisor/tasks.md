## 1. Adapter contract and invariants

- [ ] 1.1 Add a delivery-stage adapter/invariant registry next to the existing observation types (same rung as `MERGE_OPERATION_INVARIANT`), covering `planning` through `ready-to-deploy`, and verify a unit test fails when any of those stages is missing from the registry
- [ ] 1.2 Wire each delivery-stage handler to report one typed operation observation per bounded attempt through `defaultRecoverySupervisorReport` (or an injected sink), and verify a mechanical-failure fixture emits `owned: true` and does not mark complete, cancelled, or human-owned
- [ ] 1.3 Add a contract test that fails when a delivery-stage adapter chooses Cooling, wait, typed request, cancellation, or a terminal mechanical outcome, and verify a synthetic adapter that calls those treatments fails by name
- [ ] 1.4 Prove exit-zero is not verified completion unless the declared observer proves the postcondition, and verify an exit-0 fixture with unproven postcondition keeps certainty from becoming `known_complete`

## 2. Transport-retry boundary

- [ ] 2.1 Keep `gh` transient retry and `git worktree add` config-lock retry as the only stage-local loops, and verify a fixture that retries after uncertain side effects or candidate movement fails
- [ ] 2.2 Remove the fix-stage lifecycle crash-retry loop so the adapter performs one harness attempt, and verify a crashing harness is invoked once per attempt and RecoverySupervisor retains ownership
- [ ] 2.3 Preserve crashed-attempt work across RecoverySupervisor re-entry (no `removeWorktree` / reset / clean / restore on the crash path), and verify porcelain from the crashed attempt remains
- [ ] 2.4 Pass the remaining `fix_timeout` budget and the in-progress-work addendum on RecoverySupervisor re-entry, and verify the first attempt prompt has no addendum

## 3. Shared materialization

- [ ] 3.1 Widen `ensureManagedWorktree` to accept missing, stale, dirty, occupied, and remotely advanced workspaces as one seam, and verify occupied trees are not stolen and remotely advanced HEAD does not skip as matching
- [ ] 3.2 Route every delivery-stage workspace fault through that seam (or a thin facade), and verify a stage-local rematerialize/block bypass fixture fails the contract test
- [ ] 3.3 Preserve or quarantine unknown dirt and never delete it, and verify an unclassified porcelain fixture is still on disk after materialization refusal
- [ ] 3.4 Keep pipeline-owned scratch unlink on the shared classifier, and verify scratch-only porcelain still unlinks without deleting non-scratch paths

## 4. Candidate epoch and evidence invalidation

- [ ] 4.1 Start a new candidate epoch when HEAD, rematerialized SHA, or remote tip changes, and verify a prior-epoch review verdict cannot authorize advancement at the new HEAD
- [ ] 4.2 Invalidate candidate-bound test, eval, shipcheck, decision, and authority evidence on epoch change, and verify a stale authority hold is not preserved by a leftover `blocked` label

## 5. Compatibility adapters

- [ ] 5.1 Convert `tryAutoRecover` into a compatibility adapter that claims or resumes the owning Recovery Episode, and verify a comment-counted `auto_recovery_max_retries` fixture cannot post a terminal auto-recovery-limit that ends ownership
- [ ] 5.2 Convert `pipeline recover-parked` into a compatibility entrypoint on the same Recovery Episode, and verify HIGH/CRITICAL/security/authority still cannot be auto-overridden
- [ ] 5.3 Treat recover-parked fingerprint spend as a strategy-cursor position, and verify exhausting that pass leaves the Logical Operation owned
- [ ] 5.4 Record Recovery Episode treatment through the stage-attempt ledger and operation claims, and verify auto-recovery comments are not the sole authority

## 6. Observations for crash, malformed output, no-op, and non-convergence

- [ ] 6.1 Emit owned observations for harness crash, malformed/contract-failing output, unsatisfied no-op, and review non-convergence, and verify none of those fixtures mark complete, cancelled, or human-owned
- [ ] 6.2 Keep tests, review, OpenSpec, visual, eval, and shipcheck gates able to refuse advancement, and verify an eval-fail and OpenSpec-invalid fixture still do not advance
- [ ] 6.3 Keep `setBlocked` as a projector, and verify a harness-failure projection still leaves `owned: true`

## 7. Migrated-outcome inventory

- [ ] 7.1 Add a migrated-outcome field to every issue-stage row in the escalation inventory, and verify a missing-row fixture fails the drift guard
- [ ] 7.2 Map former mechanical blocking sites (worktree, harness crash, capacity, transport) to Cooling or external-condition wait, and verify they do not migrate to Authority Request
- [ ] 7.3 Prove a blocked or waiting process stop does not end RecoverySupervisor ownership, and verify advance/single/loop still never merge

## 8. Docs, validation, and CI

- [ ] 8.1 Align living specs and operator docs with adapter vs projector language without adding a public supervisor CLI verb, and verify no `pipeline supervise-advance` (or equivalent) is registered
- [ ] 8.2 After any later `core/` edit run `node scripts/build.mjs` and verify `node scripts/build.mjs --check` passes
- [ ] 8.3 Run `openspec validate migrate-issue-stages-to-recovery-supervisor` and `openspec validate --all`, and verify both exit 0
- [ ] 8.4 Run `npm run ci` from the repo root, and verify the full gate passes
