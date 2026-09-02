## 1. Invariant registry

- [ ] 1.1 Extend `DeliveryStageInvariant`, `MergeOperationInvariant`, and `ShipPhaseInvariant` with `side_effect_identity`, `safe_replay_predicate`, and `reconstruction_rule` in place, and verify a contract test fails when any delivery stage, merge, or ship phase omits a field
- [ ] 1.2 Fill those three fields on every existing delivery-stage, merge, and ship invariant using the observers named in design.md, and verify the same contract test then passes
- [ ] 1.3 Keep process exit as ingress evidence only on those invariants, and verify a fixture where exit is 0 but the observer has not proven the postcondition does not mark the Logical Operation complete

## 2. Shared stage-label derivation

- [ ] 2.1 Add one pure stage-label derivation that returns the `STAGES` member with the greatest index when multiple `pipeline:*` stage labels are present, and verify `pipeline:pre-merge` plus `pipeline:design-gate` yields `pre-merge` and does not throw
- [ ] 2.2 Point loop identity observation and train freeze/eligibility at that function, and verify train no longer throws `ambiguous pipeline stage labels` and both surfaces return the same stage
- [ ] 2.3 Keep `needs-human` as the last `STAGES` member so it wins when co-present with an in-flight stage, and verify `pipeline:needs-human` plus `pipeline:review-2` yields `needs-human` without a GitHub label write

## 3. Reconstruct next action

- [ ] 3.1 Add `reconstruct` to the closed `LoopNextAction` set, and verify `isLoopNextAction("reconstruct")` is true and an unknown member still fails
- [ ] 3.2 Change `computeNextAction` so `ledger-ahead`, `external-absent`, and `identity-mismatch` without current typed-request evidence return `reconstruct` not `noop` or `hold-for-human`, and verify the previous contradiction-is-noop fixture now fails
- [ ] 3.3 Apply `reconstruct` as an audited local ledger/claim/identity rewrite from the observer with no GitHub write, git push, label write, PR edit, release, or deploy, and verify a ledger-ahead fixture reconstructs locally and records no remote mutation
- [ ] 3.4 Keep `hold-for-human` only when a current canonical `human-decision-required` diagnostic exists after the shared classifier, and verify that fixture is unchanged

## 4. Linked-PR remote mutation

- [ ] 4.1 Extend the reconcile observation seam so completeness consults every linked PR (open, closed, merged), and verify a fixture with a merged earlier PR plus a later open PR still treats integration as `known_complete`
- [ ] 4.2 Before PR-open, rebase, or advance-still-needed, observe that linked-PR set, and verify a `fix-2` issue whose linked PR was squash-merged and contained does not open a successor PR and does not rebase squash-contained commits
- [ ] 4.3 Treat issue closure via `Closes #N` as corroborating evidence only, and verify merged-and-contained PR identity remains the postcondition even when the issue is still labeled `pipeline:fix-2`

## 5. Observe before retry and after recovery

- [ ] 5.1 Gate adapter local retry and RecoverySupervisor re-entry on `SideEffectCertainty`: `known_complete` does not replay, `known_absent` may replay under the same identity, `uncertain` stays Cooling or wait, and verify each of those three fixtures
- [ ] 5.2 Observe worktree rebase-in-progress, claimed SHA versus on-disk HEAD, and staged product dirt as local/remote drift, and verify `repair_pipeline_item` does not refuse as `needs-human` solely for that mismatch
- [ ] 5.3 Reconcile after every recovery recipe before the next adapter attempt, and verify a rematerialize or rebase-abort fixture is not treated as verified completion of the original mutation
- [ ] 5.4 Keep OpenSpec dirty-before-archive fail-closed when product dirt is present, and verify a first completed archive plus later unfinished-rebase dirt does not replay the archive and does not skip the fail-closed

## 6. Dogfood fixture and class guard

- [ ] 6.1 Add one injected-I/O #1369 fixture covering forge squash-merge while `fix-2`, mid-rebase SHA drift with staged OpenSpec dirt, labels `pipeline:pre-merge` and `pipeline:design-gate`, and partial archive, and verify the fixture fails without the reconcile law
- [ ] 6.2 Assert that fixture does not throw, does not open a successor PR, does not rebase squash-contained commits, does not skip dirty-archive fail-closed, and does not project `hold-for-human` without typed-request evidence
- [ ] 6.3 Add a class-guard that fails if a production path classifies by matching `ambiguous pipeline stage labels` or another thrown error message, and verify a synthetic error-name branch fixture fails that guard
- [ ] 6.4 Cover contradictory labels, remote or local drift, stale evidence, remote mutation by another actor, and partial external operations as distinct injected fixtures, and verify each would fail on the pre-change behavior

## 7. Docs, packaging, and CI

- [ ] 7.1 Align `CONTEXT.md` Operation invariant, Authoritative observer, Candidate epoch, and Side-effect certainty entries with reconstruction and supervisor-owned contradictions, and verify they no longer say contradictions route to a human
- [ ] 7.2 After any `core/` edit run `node scripts/build.mjs` and refresh generated docs if the generator is present, and verify `node scripts/build.mjs --check` passes
- [ ] 7.3 Run `openspec validate prove-invariants-and-reconcile` and `openspec validate --all`, and verify both exit 0
- [ ] 7.4 Run `npm run ci` from the repo root, and verify the full gate passes
