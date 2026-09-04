## 1. Persist recognizable single / merge / merge-queue artifacts

- [x] 1.1 Extend `RunKind` and `initRunDir` so public admission of `pipeline single`, `pipeline merge`, and `pipeline merge-queue` writes a control-host generic-store run with recognized `kind` and a stable prefix (`single-`, `merge-`, `merge-queue-` / `mq-`), and verify hermetic tests that those commands persist `run.json` plus `run_start` without a second run store
- [x] 1.2 Keep nested loop children of `pipeline single` as `loop` artifacts, and verify a single admission observes both `single` (parent) and `loop` (child) when the child exists
- [x] 1.3 Do not map numeric drive ids or `kind: "advance"` to `single`, and verify those artifacts stay `drive` / unmapped
- [x] 1.4 Do not treat nested `train_merge_*` events or `merge-queue-repair-pr-*` helper ids as public `merge` / `merge-queue`, and verify those shapes do not populate `entrypoint_coverage.observed` for those entrypoints
- [x] 1.5 Keep fail-closed behavior when those artifacts are absent, and verify missing required coverage still increases for `single`, `merge`, and `merge-queue` on a host store that has only `train-*` and numeric-drive runs

## 2. Map remaining public entrypoints

- [x] 2.1 Extend `mapPublicEntrypointFromRunId` with prefix `single-` while keeping `merge-queue-` / `mq-` before remaining `merge-`, and verify `single-1` maps `single`, `mq-1` maps `merge-queue`, `merge-1` maps `merge`
- [x] 2.2 Keep mapping precedence (recognized `run_start.entrypoint`, then recognized `run.json.kind`, then prefixes), and verify start-event still wins over kind and prefix
- [x] 2.3 Verify in-flight ship scoring with injected unbound `single-` / `merge-` / `merge-queue-` artifacts observes those three entrypoints and does not count them as verified unique-operation success

## 3. Followable train-link join

- [x] 3.1 Extend the `train_loop_linked` join so a followable event (nonempty `loop_run_id`, absolute events path that `loadFollowableChildRun` loads inside the approved roots, child logical id from the event or loaded child) sets live train-link, and verify a hermetic fixture with that shape increments live train-link and does not increment missing required coverage for #1301
- [x] 3.2 Do not require the child's `run_id` fallback identity to equal the train minted id, and verify a train minted id `T` plus child fallback `loop-1` still counts as live train-link and does not increment contradictory correlation solely for that fallback mismatch
- [x] 3.3 Leave #1301 fail-closed when `train` is observed without a followable child, and verify missing required coverage increases in that case
- [x] 3.4 Keep refusing a `train_loop_linked` events path that escapes the approved roots, and verify that path is not loaded and does not count as live train-link

## 4. Commit-bound #1333 attach on live from-run

- [x] 4.1 Change `defaultLoadCandidateFaultRecoveryInventory` so it loads the commit-bound inventory blob at the scored SHA and returns `sourceSha` equal to that SHA even when checkout HEAD differs, and verify a hermetic test with HEAD `H ≠ C` and a complete blob at `C` attaches binder-accepted rows for all five #1333 classes
- [x] 4.2 Keep refusing an incomplete blob, a blob sourced from a different SHA, and standalone factory-gate minting, and verify those cases separately still fail as missing required coverage
- [x] 4.3 Do not stamp `passingUniqueOperationManifest().covered_lifecycle_classes`, and verify helper stamps still fail promotion
- [x] 4.4 Prove the attach on a live `factory-gate --from-run` / `defaultScoreBoundPackLoop` score whose worktree HEAD is not the scored SHA, and verify scored evidence `executed_matrix_rows` is nonempty and bound to that SHA

## 5. Hard-gate, docs, and CI

- [x] 5.1 Keep `uniqueOperationSloFailure` on `factory-release prepare` `frg_not_eligible`, and verify the hard-gate message still includes that string when unique-operation coverage is the defect
- [x] 5.2 Update `docs/factory-reliability-gate-runbook.md` unique-operation section so it names followable `train_loop_linked` (absolute path + child logical id), recognizable `single` / `merge` / `merge-queue` artifacts, and commit-blob #1333 attach when HEAD differs from the scored SHA
- [x] 5.3 After any `core/` edit run `node scripts/build.mjs`, and verify `node scripts/build.mjs --check` passes
- [x] 5.4 Run `openspec validate ship-unique-op-remaining-slo-coverage` and `npm run ci` from the repo root, and verify both exit 0
