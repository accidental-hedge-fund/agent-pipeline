## Why

After #1440 (`d0c5cb32`), live `pipeline ship --milestone v1.40.1` still fails the Factory Reliability Gate unique-operation SLO with `missing required coverage (4)`. Scored evidence `frg-2026-09-04T23-26-39-082Z-d9c7b762` from pack loop `loop-c7399a584cc1a4fd` observes `drive`, `loop`, and `train` (515 operations) and now has #1333 `executed_matrix_rows` bound to `d0c5cb32`. It still misses public entrypoints `single`, `merge`, and `merge-queue`, and it still misses #1301 live train-link. Control-host `.agent-pipeline/runs` still has no `single-*` / `merge-*` / `merge-queue-*` prefixes. Numeric advance ids still map to `drive`. `train_loop_linked` exists on the train stream, but scored operations do not carry a followable child logical id inherited from the parent. This is a class producer/collector/join defect, not a v1.40.1 mole.

## What Changes

- Public `pipeline single`, `pipeline merge`, and `pipeline merge-queue` admissions SHALL persist recognizable run artifacts into the same dual-root pair unique-operation collection scores (control-host generic store from `resolveFactoryControlRoot` plus loop state-home). Persist SHALL NOT write only to a candidate-worktree `repoDir` that collection does not read.
- Unique-operation collection SHALL observe those three entrypoints from real control-host artifacts (`run.json.kind`, `run_start.entrypoint`, command identity, or a documented run-id prefix). Collection SHALL NOT invent successes. Numeric drive and `kind: "advance"` SHALL stay unmapped to `single`. Nested `train_merge_*` events SHALL NOT count as public `merge` / `merge-queue`.
- Live train-link (#1301) SHALL count only from a followable `train_loop_linked` event: nonempty child loop run id, an absolute events path that loads inside the approved dual-root pair, and a child logical id inherited from the parent train operation. Observing `train` alone SHALL NOT satisfy the link cell. Scored operations SHALL carry that followable child logical id.
- Fail-closed behavior SHALL remain when those artifacts or that followable child are absent. `uniqueOperationSloFailure` SHALL remain on the factory-release prepare hard gate.
- #1333 inventory attach is already bound after #1440 and is out of scope.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `operation-reliability`: public `single` / `merge` / `merge-queue` persist into the dual-root collection scores; collection observes those entrypoints only from real artifacts; live train-link inherits the parent logical id onto the scored train operation from a followable `train_loop_linked` event.
- `factory-reliability-gate`: in-flight ship unique-operation scoring observes those remaining SLO cells from the dual-root host artifacts and followable parent-inherited train-link; `uniqueOperationSloFailure` stays on the prepare hard gate.

## Impact

- **Class vs site:** class is unique-operation evidence for release-eligible FRG public entrypoints and #1301 live train-link. Site `v1.40.1` / pack loop `loop-c7399a584cc1a4fd` / evidence `frg-2026-09-04T23-26-39-082Z-d9c7b762` is one observation of that class. Shared surfaces: `persistPublicEntrypointAdmission` write root, `resolveUniqueOperationRunsRoots` / `collectUniqueOperationsFromRunStore`, `attemptsFromRunArtifacts` / `followableChildLogicalId`, aggregator live-link increment plus scored-operation child id, and prepare `uniqueOperationSloFailure`. The next identical missing-`single`/`merge`/`merge-queue` (wrong persist root) or unjoined `train_loop_linked` (no inherited parent child id) uses this same law. It does not need a new mole issue.
- **Reuse first:** keep the dual-root collector, `initRunDir` / `persistPublicEntrypointAdmission`, mapper prefixes, train-link join, and SLO functions. Point persist at the same approved roots collection already reads. Inherit the parent train logical id when the event is followable. Do not add a second aggregator, FRG runner, scheduler, unique-operation CLI, or run store.
- **CLI:** no new public verb. No merge-authority change. HMAC attestation on tag/promote stays required. `ship` stays in `REQUIRED_PUBLIC_ENTRYPOINTS`.
- **Tests:** hermetic unit tests inject host run stores and followable train events. No live network in unit tests.
- **Out of scope:** merging factory-gate pack PRs from recover; dropping `ship` from required entrypoints; re-stamping #1333 inventory rows; inventing unique-operation successes when host artifacts are actually absent.

## Acceptance Criteria

- [ ] `pipeline single`, `pipeline merge`, and `pipeline merge-queue` persist recognizable artifacts into the dual-root pair unique-operation collection scores (`runsDir(resolveFactoryControlRoot(...))` and/or loop state-home `<resolveStateHome()>/runs`). A persist that lands only under a candidate-worktree `repoDir` that is not an approved collection root does not satisfy those entrypoints.
- [ ] In-flight ship unique-operation scoring observes `single`, `merge`, and `merge-queue` when those dual-root artifacts carry a recognized `run.json.kind`, `run_start.entrypoint`, command identity, or documented prefix (`single-`, `merge-`, `merge-queue-` / `mq-`). Numeric drive ids stay `drive`. `kind: "advance"` is not `single`. Nested `train_merge_*` events are not public `merge` coverage.
- [ ] Collection does not mint coverage when those artifacts are absent from the approved roots. A host store with only `train-*` and numeric-drive runs still fails closed for `single`, `merge`, and `merge-queue`.
- [ ] A control-host train stream with a followable `train_loop_linked` event (nonempty `loop_run_id`, absolute events path inside the approved roots that loads the linked child) inherits the parent train logical id as the child logical id on the scored train operation and does not increment missing required coverage for #1301. A `train` attempt without that followable child does not count as live train-link.
- [ ] An empty host store and a non-followable train event still fail closed as missing required coverage. `factory-release prepare` `frg_not_eligible` still names `uniqueOperationSloFailure`.
