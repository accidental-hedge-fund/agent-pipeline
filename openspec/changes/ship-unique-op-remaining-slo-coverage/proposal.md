## Why

After #1434 (`a35fb505`), live `pipeline ship --milestone v1.40.1` still fails the Factory Reliability Gate unique-operation SLO with `missing required coverage (9)`. Host collection now reads the control-host generic store, but three remaining cells stay empty: public entrypoints `single`, `merge`, and `merge-queue`; #1301 live train-link even when `train_loop_linked` exists; and all five #1333 lifecycle classes because scored `executed_matrix_rows` stay empty. This is a class collector/producer/join defect, not a v1.40.1 mole.

## What Changes

- Unique-operation collection SHALL observe `single`, `merge`, and `merge-queue` from control-host run artifacts (`run.json.kind`, `run_start.entrypoint`, or a documented run-id / command mapping). Those public commands SHALL persist recognizable artifacts through the existing run store. Collection SHALL NOT invent synthetic successes, SHALL NOT coerce numeric drive or `kind: "advance"` to `single`, and SHALL NOT treat nested train merge events as a public `merge` admission.
- Live train-link (#1301) SHALL increment from a followable `train_loop_linked` event on the control-host train stream: nonempty child loop run id plus an absolute events path that loads inside the approved host roots, plus a child logical id from that event or the loaded child. A `train` entrypoint without a followable child SHALL NOT count. The join SHALL NOT require the child's `run_id` fallback identity to equal the train minted id.
- In-flight ship scoring SHALL attach candidate-bound #1333 `executed_matrix_rows` when `assertFaultRecoveryInventoryComplete` passes on the commit-bound inventory blob at the scored SHA. Checkout HEAD MAY differ from that SHA. Prove this on a live `--from-run` score, not only a unit fake SHA. Helper `covered_lifecycle_classes` stamps SHALL still fail.
- Fail-closed behavior SHALL remain when those artifacts are actually absent. `uniqueOperationSloFailure` SHALL remain on the prepare hard gate.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `operation-reliability`: public `single` / `merge` / `merge-queue` admissions persist recognizable control-host run artifacts; mapping observes those kinds, start-event entrypoints, and documented prefixes (`single-` in addition to existing `merge-` / `merge-queue-` / `mq-`); live train-link counts from a followable `train_loop_linked` event (absolute events path + child logical id) without requiring child `run_id` fallback to match the train minted id.
- `factory-reliability-gate`: in-flight ship unique-operation scoring observes those remaining SLO cells from host artifacts and followable train linkage; in-flight #1333 rows attach from the commit-bound inventory blob at the scored SHA on a live from-run score even when checkout HEAD differs; `uniqueOperationSloFailure` stays on the prepare hard gate.
- `universal-fault-recovery-matrix`: in-flight inventory load uses the git object at the scored candidate SHA. A checkout HEAD that differs from that SHA SHALL NOT by itself refuse a valid blob at that SHA.

## Impact

- **Class vs site:** class is unique-operation evidence for release-eligible FRG. Site `v1.40.1` / pack loop `loop-0bce0103237e16f3` / evidence `frg-2026-09-04T20-58-57-132Z-ea1bcc25` is one observation of that class. Shared surfaces: `initRunDir` / `RunKind` / run-id helpers, `attemptsFromRunArtifacts` / `mapPublicEntrypointFromRunId`, `trainLinkedEventRefs` plus the aggregator live-link increment, `defaultLoadCandidateFaultRecoveryInventory` / `executedRowsFromCompleteInventory`, and prepare `uniqueOperationSloFailure`. The next identical missing-`single`/`merge`/`merge-queue` / unjoined `train_loop_linked` / HEAD-gated inventory miss uses this same law. It does not need a new mole issue.
- **Reuse first:** keep the dual-root collector, binder, SLO functions, inventory guard, and `initRunDir`. Extend mapping prefixes and the train-link join. Load the existing commit-bound inventory blob at the scored SHA. Do not add a second aggregator, FRG runner, scheduler, unique-operation CLI, or executed-row store.
- **CLI:** no new public verb. No merge-authority change. HMAC attestation on tag/promote stays required. `ship` stays in `REQUIRED_PUBLIC_ENTRYPOINTS`.
- **Tests:** hermetic unit tests inject host run stores, followable train events, and inventory blobs. One live from-run proof is required for #1333 attach when HEAD differs from the scored SHA. No live network in unit tests.
- **Out of scope:** merging factory-gate pack PRs from recover; dropping `ship` from required entrypoints; stamping `passingUniqueOperationManifest().covered_lifecycle_classes`; inventing unique-operation successes when the host artifacts are actually absent.

## Acceptance Criteria

- [ ] In-flight ship unique-operation scoring observes `single`, `merge`, and `merge-queue` when control-host run artifacts carry a recognized `run.json.kind`, `run_start.entrypoint`, or documented prefix (`single-`, `merge-`, `merge-queue-` / `mq-`). Numeric drive ids stay `drive`. `kind: "advance"` is not `single`. Nested `train_merge_*` events are not public `merge` coverage.
- [ ] `pipeline single`, `pipeline merge`, and `pipeline merge-queue` persist those recognizable artifacts through the existing run store on a real admission. Collection does not mint coverage when those artifacts are absent.
- [ ] A control-host train stream with a followable `train_loop_linked` event (nonempty `loop_run_id`, absolute events path inside the approved host roots, child logical id on the event or loaded child) increments live train-link and does not increment missing required coverage for #1301. A `train` attempt without that followable child does not count as live train-link.
- [ ] In-flight ship scoring attaches binder-accepted `executed_matrix_rows` for all five #1333 classes from the commit-bound inventory blob at the scored SHA when `assertFaultRecoveryInventoryComplete` passes, including when checkout HEAD differs from that SHA. A live `--from-run` score proves that attach. Helper class stamps still fail. Incomplete or missing blobs stay fail-closed.
- [ ] An empty host store, a non-followable train event, and an incomplete inventory still fail closed as missing required coverage. `factory-release prepare` `frg_not_eligible` still names `uniqueOperationSloFailure`.
