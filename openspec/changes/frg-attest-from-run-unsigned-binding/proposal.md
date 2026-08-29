## Why

`pipeline ship --milestone v1.39.15` never left `frg_pack`. Uncredentialed prepare closed unsigned `frg_run_id=A` (`frg-cede01998b2bc2f0ef510840`). Credentialed `factory-gate --from-run` minted a new `run_id=B` (`frg-2026-08-29T13-15-12-562Z-90e766aa`), wrote `pack_provenance`, and did not write HMAC `factory_release_binding`. Prepare observe returned null because `run_id` was not `A` and `pack_provenance != null`. Ship classified `"attest"` with no cap and spawned factory-gate again. The same hang happened on v1.39.14. The next pin≠candidate ship will hang the same way.

This is a **class** defect: the two-call unsigned→attest handoff does not join distinct audit identities `A` and `B` with an HMAC-covered typed binding, and `"attest"` ticks have no termination. Closed #1147/#1133/#1118/#1151 defined the two-call split, pack provenance, and candidate engine. None of them made `--from-run` sign the unsigned checkpoint. Collapsing `A` and `B` into one `run_id` is not the product contract.

## What Changes

- **Attestor writer:** credentialed `factory-gate --for <X.Y.Z> --from-run <loop>` (and the in-process equivalent) SHALL create typed top-level `factory_release_binding` **before** HMAC. The binding SHALL join attested `run_id=B` to closed unsigned checkpoint `A`. Unsigned prepare and ship SHALL NOT add or overlay that field after sign.
- **Distinct identities:** `A` (unsigned `frg_run_id`) and `B` (attestor `run_id`) remain distinct audit identities. `B` SHALL be deterministic and idempotent for the complete checkpoint binding of unchanged `A`. Reprocessing unchanged `A` SHALL resolve to the same `B`, not `B2`, `B3`, …
- **Observe:** `tryLoadAttestedEvidence` / `defaultObserveAttestation` SHALL return a typed **accepted**, **absent**, or **rejected** result. HMAC-pass `--from-run` `latest.json` with `run_id=B` SHALL be accepted when `factory_release_binding` matches the unsigned checkpoint. Presence of `pack_provenance` SHALL NOT be grounds for rejection. `pack_provenance`, notes, and inferred provenance SHALL NOT substitute for `factory_release_binding`.
- **Prepare complete:** `factory-release prepare` SHALL NOT refuse that HMAC-pass solely because `evidence.run_id !== unsigned.frg_run_id` when the HMAC-covered binding names unsigned `A` and matches the closed digests. It SHALL then return `status: "complete"` (or the next legal prepare mutation).
- **Bounded attest:** ship-path composers, including in-engine `runFrgPack`, SHALL invoke the attestor **at most once** for an unchanged complete checkpoint binding, then invoke prepare once more. Absent or rejected observe after that tick SHALL fail closed and SHALL name `A`, `B` when available, and the exact miss reason. A changed complete checkpoint binding SHALL mint a new deterministic `B` and reset the allowance.
- **Does not:** skip FRG; collapse production `A` and `B` into one `run_id`; overlay `factory_release_binding` after HMAC; use notes as the binding carrier; make leaf `release` / `finish` / `ensure-tag` the product ship path; change the closed recovery-recipe catalogue; restore `--skip-frg`; merge inside advance/loop.

## Acceptance criteria

- [ ] Credentialed `factory-gate --from-run` (or in-process equivalent) writes HMAC `latest.json` whose top-level `factory_release_binding` is present **before** HMAC and exactly matches request fingerprint, target version, integrated candidate SHA, pack identity, pack run ID, loop run ID, unsigned `frg_run_id` `A`, and every closed unsigned artifact digest.
- [ ] That `latest.json` has attested `run_id=B` distinct from unsigned `A`. Re-running `--from-run` on unchanged `A` writes the same `B`. It does not mint `B2`.
- [ ] `defaultObserveAttestation` / `tryLoadAttestedEvidence` accepts HMAC-pass `--from-run` `latest.json` with `run_id=B`, `pack_provenance` present, and matching HMAC `factory_release_binding`. It does not return absent/null solely because `pack_provenance != null` or `run_id !== A`.
- [ ] The same observe path rejects HMAC-pass `run_id=B` + `pack_provenance` with **no** `factory_release_binding` (and rejects notes-only or inferred provenance as the binding). The result is typed **rejected** with a stable reason code plus expected and observed identities. It is not treated as success.
- [ ] After that accepted observe, uncredentialed `factory-release prepare` on the unchanged request returns `status: "complete"` (or proceeds to shared `runRelease`). It does not stay `awaiting_frg_attestation` solely because `evidence.run_id` is `B`.
- [ ] In-engine `runFrgPack` invokes factory-gate at most once for an unchanged checkpoint, then prepare once more. If observe is still absent or rejected, it throws. The error names unsigned `A`, observed `B` when present, and the miss reason. It does not spawn another factory-gate.
- [ ] A unit test fails if unsigned `frg_run_id=A`, `--from-run` writes `run_id=B` + `pack_provenance` and no `factory_release_binding`, and observe is treated as success **or** `runFrgPack` never terminates.
- [ ] The existing test `candidate FRG pack re-invokes the same prepare request after factory-gate until complete` drives a real-shaped `--from-run` payload through the observe contract. It does not mock factory-gate as a no-op that magically makes the next prepare return `complete`.
- [ ] Tests cover success (`A`→bound `B`), mismatch rejection, bounded termination, and restart idempotency (unchanged `A` → same `B`). They inject I/O. They do not use real network, git, or subprocess.
- [ ] After any `core/` edit, `plugin/` is regenerated in the same change. `npm run ci` is green.

## Capabilities

### New Capabilities

<!-- None. This joins existing unsigned and attested FRG identities. -->

### Modified Capabilities

- `factory-reliability-gate`: Credentialed `--from-run` SHALL write HMAC-covered top-level `factory_release_binding` that joins deterministic attestor identity `B` to unsigned checkpoint `A` **before** HMAC. `pack_provenance` remains subject to its normal validation but SHALL NOT substitute for that binding and SHALL NOT by itself reject observe. Notes SHALL NOT be an authoritative binding carrier. Ship-path composers SHALL attest an unchanged checkpoint at most once, then fail closed on absent/rejected observe.
- `release-sub-command`: `factory-release prepare` observe SHALL return typed accepted / absent / rejected. It SHALL accept HMAC-pass `--from-run` evidence whose `run_id` is `B` when `factory_release_binding` matches unsigned `A` and the closed digests. Prepare SHALL NOT stay `awaiting_frg_attestation` solely because `evidence.run_id !== unsigned.frg_run_id` when that binding matches. Prepare SHALL NOT overlay the binding after sign.
- `ship-coordinator`: In-engine `runFrgPack` SHALL spawn factory-gate at most once for an unchanged complete checkpoint binding, then re-invoke the same prepare request once. Absent or rejected observe SHALL fail the FRG pack phase and SHALL name `A`, `B` when available, and the miss reason. `"attest"` SHALL NOT `continue` forever. A changed complete checkpoint binding SHALL reset the allowance.

## Impact

- `core/scripts/factory-reliability-gate.ts` — `--from-run` / `runFactoryGate` / `computeFrgEvidence`: load closed unsigned checkpoint for the scored loop, set deterministic `run_id=B`, attach `factory_release_binding` before HMAC, persist `latest.json`. Stop using timestamp+random `newFrgRunId` on this ship-path.
- `core/scripts/factory-release-prepare.ts` — `tryLoadAttestedEvidence`, `defaultObserveAttestation`, prepare complete binding check: typed observe; accept `A≠B` via HMAC binding; stop treating `pack_provenance != null` as automatic miss; stop using notes as the binding carrier; stop requiring `attestation.frg_run_id === unsigned.frg_run_id` when the binding names `A`.
- `core/scripts/stages/ship-adapter.ts` — `runFrgPack` / `classifyFrgPackWaitDecision`: cap `"attest"` at one spawn per unchanged checkpoint; fail closed with `A`, `B`, miss reason.
- Tests: `core/test/factory-release-prepare.test.ts`, `core/test/factory-reliability-gate.test.ts`, `core/test/ship-adapter.test.ts`. Bite: unsigned `A`, from-run payload `B` + `pack_provenance` without binding is not observe-success and `runFrgPack` terminates. Existing `#1151` re-invoke test must drive the real observe contract.
- Docs: FRG runbook / ship-milestone may name `A` vs `B` joined by HMAC `factory_release_binding`. No `--skip-frg` restore. No `auto_merge`.
- Prerequisite: #1298 / #1308 (Layer A / packed candidate SHA is the integrated candidate). This change does not re-open that identity resolver.
- Tugboat already fail-closes after one attestor spawn. It consumes the same HMAC `latest.json`. No Tugboat-only mole. Composer attest-once law still lives on the shared factory-reliability-gate requirement so a later composer cannot uncap `"attest"`.
