## Why

Live `v1.40.1` shipment remains blocked because Factory Reliability Gate unique-operation collection cannot prove required `single`, `merge`, and `merge-queue` admissions from durable control-host artifacts. The current public-admission helper is not a fail-closed durability boundary, train merge mode does not record its nested merge identity, and no shared inventory prevents another required entrypoint from shipping without an admission stamp.

## What Changes

- Make the existing control-host generic run-store admission path the shared contract for required public-entrypoint stamps, with crash-durable publication, approved-root enforcement, and a machine-checked inventory corresponding to `REQUIRED_PUBLIC_ENTRYPOINTS`.
- Require each admitted record to carry the exact public entrypoint, matching `run.json.kind` and `run_start.entrypoint`, and the admitted root `logical_operation_id`.
- Require direct `pipeline single`, `pipeline merge`, and `pipeline merge-queue` to durably persist their stamps before entering their protected execution or side-effect boundary.
- Require `pipeline train --merge` to persist a distinct nested `merge` record before merge submission while retaining the outer train Logical Operation identity and the separate outer `train` record.
- Treat admission persistence failure as mechanical lifecycle evidence and refuse the protected side effect; a stamp never grants authority or proves completion or success.
- Keep numeric invocation mapped to `drive`, keep collection fail-closed when a qualifying artifact is absent, and keep `uniqueOperationSloFailure` on the release-prepare hard gate.
- Add network-free tests over injected run-store seams for direct and nested stamped attempts, missing-artifact behavior, drive/single separation, persistence failure, and required-entrypoint inventory completeness.
- Introduce no CLI verb, host engine, scheduler, run store, merge/release authority, or per-verb documentation surface.

## Acceptance Criteria

- [ ] A successful shared admission write creates a durable control-host generic-run artifact whose `run.json.kind`, `run_start.entrypoint`, and public entrypoint all identify the admitted command and whose `logical_operation_id` equals the admitted root Logical Operation.
- [ ] Admission acknowledgement occurs only after atomic publication and fsync of `run.json` and `events.jsonl`, fsync of their containing directory and its parent run-store directory, and successful final-file read-back; failure of any injected publication or flush step refuses protected work.
- [ ] Admission fails with a typed persistence result when no approved control-host root is available; it never falls back to a candidate worktree for an acknowledged stamp.
- [ ] Direct `pipeline merge` persists a qualifying `merge` artifact before merge submission; if persistence or read-back verification fails, no merge submission occurs.
- [ ] `pipeline train --merge` preserves its outer `train` artifact and persists a separate nested artifact identified as `merge` before each nested merge submission.
- [ ] A nested train merge artifact retains the outer train admission's `logical_operation_id` while remaining observable as entrypoint `merge`.
- [ ] Direct `pipeline merge-queue` persists a qualifying `merge-queue` artifact before any apply-mode merge or repair side effect; if persistence or read-back verification fails, that protected work does not start.
- [ ] Direct `pipeline single` persists a qualifying `single` artifact before its supervised drive starts; numeric `pipeline <issue>` continues to persist and classify as `drive`, never `single`.
- [ ] Direct `pipeline single` passes the admitted root `logical_operation_id` into its child loop, and train merge mode performs no nested merge when its outer train identity was not durably established.
- [ ] A qualifying admission artifact proves only that the operation was admitted; it does not by itself count as verified completion, successful mutation, merge authority, or release authority.
- [ ] Unique-operation collection reports `single`, `merge`, or `merge-queue` as observed only when a qualifying durable artifact for that entrypoint exists in an approved control-host root.
- [ ] A store containing only `drive`, `loop`, and `train` artifacts reports `single`, `merge`, and `merge-queue` in required missing coverage, and a drive artifact never satisfies `single` coverage.
- [ ] `single`, `merge`, and `merge-queue` remain in `REQUIRED_PUBLIC_ENTRYPOINTS`, and a machine-checked shared inventory fails when any required public entrypoint lacks a declared shared admission site.
- [ ] An admission-stamp persistence failure is reported as mechanically owned lifecycle evidence and is not projected as human authority without independent typed-request evidence.
- [ ] Every admission caller reports persistence failure through a pre-bound RecoverySupervisor adapter carrying the same logical-operation id, physical run id, domain, and repository that were established before persistence began.
- [ ] `uniqueOperationSloFailure` remains a release-prepare hard-gate failure when required stamped coverage is absent.
- [ ] Network-free tests using an injected run-store seam exercise direct merge, nested train merge, merge-queue, and single persistence and collection, plus persistence-failure and absent-artifact regressions.
- [ ] Generated unique-operation and FRG documentation, if affected, remains consistent with the required stamped entrypoints without adding a public verb or per-verb command document.
- [ ] `openspec validate` and the repository's full `npm run ci` gate pass with generated host and documentation artifacts fresh.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `operation-reliability`: define the shared, fail-closed required-entrypoint admission stamp, payload and Logical Operation rules, inventory correspondence, honest artifact-only collection, and drive/single distinction.
- `supervised-train-merge`: require direct and train-nested merge work to cross the protected merge boundary only after a durable shared admission stamp, while preserving existing merge authority and RecoverySupervisor ownership.
- `factory-reliability-gate`: score stamped direct and nested public-entrypoint artifacts without synthesizing coverage and retain `uniqueOperationSloFailure` as a release-prepare hard gate.

## Impact

- **Class vs site:** the class defect is a required public entrypoint without a durably confirmed shared admission record. The `v1.40.1` FRG result is one site. The inventory correspondence gate makes future missing admission sites fail CI instead of requiring another ship-recovery issue.
- **Reuse first:** extend `persistPublicEntrypointAdmission`, the existing generic-run serializers/layout, the control-host root resolver, Logical Operation propagation, and the existing collector/mapper. The acknowledged writer does not treat the error-swallowing `initRunDir` / `appendEvent` path as a durability boundary. Do not add a second run store, aggregator, recovery controller, or command-specific stamp implementation.
- **Protected boundaries:** direct merge and train-nested merge stamp before merge submission; merge-queue stamps before apply-mode protected work; single stamps before its supervised drive. Existing authorization and exact-candidate merge invariants remain unchanged.
- **Affected implementation surfaces:** `core/scripts/run-store.ts`, the existing observation adapter in `core/scripts/operation-observation.ts`, public dispatch in `core/scripts/pipeline.ts`, train merge dependencies in `core/scripts/stages/train.ts`, unique-operation collection/classification, and their injected-seam unit tests.
- **Documentation and packaging:** no new public command or host surface. Existing generated host skills and generated FRG/unique-operation documentation are regenerated only if their sources change.
- **Out of scope:** factory-gate recovery merges; replaying or fabricating operations for coverage; removing required entrypoints; changing merge, release, or auto-merge authority; allowing advance or loop to merge; coercing drive into single; demoting the FRG hard gate.
