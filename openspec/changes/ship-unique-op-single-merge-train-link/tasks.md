## 1. Persist public admissions into the collection dual-root

- [x] 1.1 Point `persistPublicEntrypointAdmission` for `pipeline single`, `pipeline merge`, and `pipeline merge-queue` at `runsDir(resolveFactoryControlRoot(...))` when that factory-control root is non-null, keep `initRunDir` as the store, and verify a hermetic test that those commands write `run.json.kind` plus `run_start.entrypoint` under the factory-control generic store rather than a candidate-worktree `repoDir`
- [x] 1.2 Leave unique-operation coverage fail-closed when factory-control root is null or the only persist lands under a candidate-worktree run store that is not an approved collection root, and verify missing required coverage still increases for `single`, `merge`, and `merge-queue` in that case
- [x] 1.3 Keep nested loop children of `pipeline single` as `loop`, keep numeric drive and `kind: "advance"` unmapped to `single`, keep nested `train_merge_*` and `merge-queue-repair-pr-*` unmapped to public `merge` / `merge-queue`, and verify those shapes do not populate `entrypoint_coverage.observed` for those entrypoints

## 2. Observe real dual-root artifacts without inventing coverage

- [x] 2.1 Keep mapping from `run.json.kind`, `run_start.entrypoint`, and documented prefixes (`single-`, `merge-`, `merge-queue-` / `mq-`), and verify in-flight ship scoring observes those three entrypoints when the artifacts exist in the approved dual-root pair
- [x] 2.2 Keep fail-closed behavior when those artifacts are absent from the approved roots, and verify a host store with only `train-*` and numeric-drive runs still reports `single`, `merge`, and `merge-queue` missing
- [x] 2.3 Do not mint synthetic unique-operation successes during ship scoring, and verify collection does not create `single-*` / `merge-*` / `merge-queue-*` coverage from pack-issue labels, comment prose, or nested train merge events

## 3. Inherit parent logical id on followable train-link

- [x] 3.1 Extend the `train_loop_linked` join so a followable event (nonempty `loop_run_id`, absolute events path that loads the linked child inside the approved roots) inherits the parent train logical id when the event and loaded child omit a minted id, and verify the scored train operation carries that child logical id and missing required coverage does not increase for #1301
- [x] 3.2 Keep using the child's minted logical id when it differs from the train identity, and verify that distinct child id still counts as live train-link without contradictory correlation solely as a failed join
- [x] 3.3 Leave #1301 fail-closed when `train` is observed without a followable child, and when a `train_loop_linked` event exists but the scored train operation does not carry a followable child logical id, and verify missing required coverage increases in both cases
- [x] 3.4 Keep refusing an events path that escapes the approved roots and an unrelated in-root path, and verify those shapes are not live train-link
- [x] 3.5 Resolve the train-link child by the event's validated absolute events path before run-id aggregation, and verify a dual-root fixture where a stale same-id child in the first approved root does not drop the event-referenced child in a later root

## 4. Hard-gate, docs, and CI

- [x] 4.1 Keep `uniqueOperationSloFailure` on `factory-release prepare` `frg_not_eligible`, and verify the hard-gate message still includes that string when unique-operation coverage is the defect
- [x] 4.2 Update `docs/factory-reliability-gate-runbook.md` unique-operation section so it names persist into the dual-root collection scores and followable `train_loop_linked` with a child logical id inherited from the parent, and verify it does not claim that observing `train` alone satisfies #1301
- [x] 4.3 After any `core/` edit run `node scripts/build.mjs`, and verify `node scripts/build.mjs --check` passes
- [x] 4.4 Run `openspec validate ship-unique-op-single-merge-train-link` and `npm run ci` from the repo root, and verify both exit 0
