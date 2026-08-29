## ADDED Requirements

### Requirement: In-engine runFrgPack SHALL fail closed after one attest observation

In-engine `pipeline ship` FRG pack (`runFrgPack` / `bindCandidateShipEndOperations`) SHALL spawn credentialed candidate `factory-gate --for <X.Y.Z> --from-run <loop_run_id>` at most once for an unchanged complete unsigned checkpoint binding. After that child exits 0, it SHALL re-invoke the same candidate `factory-release prepare --request <absolute-request.json> --json` once. If that prepare still returns `status: "awaiting_frg_attestation"` because observation is absent or rejected, `runFrgPack` SHALL throw. The error SHALL name unsigned `frg_run_id` `A`, observed `latest.json` `run_id` `B` when present, and the observe miss reason. It SHALL NOT `continue` forever on `"attest"`. It SHALL NOT spawn another factory-gate for that binding.

A changed complete checkpoint binding SHALL reset the allowance. Live `"retry"` wait while the bound pack loop is live SHALL keep the existing #1150 law. `"attest"` SHALL NOT inherit that live-loop uncap.

The existing re-invoke test SHALL drive a real-shaped `--from-run` payload (HMAC-pass `run_id=B`, `pack_provenance`, top-level `factory_release_binding` matching unsigned `A`) through the observe contract. It SHALL NOT mock factory-gate as a no-op that magically makes the next prepare return `complete`. A unit test SHALL fail if unsigned `A` plus `--from-run` `B` + `pack_provenance` and no `factory_release_binding` is treated as observe success, or if `runFrgPack` never terminates.

This requirement does not authorize `--skip-frg`. It does not treat standalone `pipeline release` as a substitute for prepare `complete`.

#### Scenario: HMAC from-run latest.json is observable or ship fails closed

- **WHEN** unsigned checkpoint `frg_run_id` is `A`
- **AND** HMAC `latest.json` `run_id` is `B` for the same loop and candidate
- **AND** in-engine `runFrgPack` has spawned factory-gate once and re-invoked prepare once
- **THEN** prepare SHALL return `status: "complete"` when `factory_release_binding` matches `A`
- **OR** `runFrgPack` SHALL throw naming `A`, `B`, and the miss reason when observation is absent or rejected
- **AND** it SHALL NOT loop

#### Scenario: Attest ticks are bounded

- **WHEN** prepare keeps returning `status: "awaiting_frg_attestation"` for unchanged unsigned `A`
- **AND** ship has already spawned factory-gate once for that checkpoint
- **THEN** `runFrgPack` SHALL throw
- **AND** it SHALL NOT spawn another factory-gate

#### Scenario: Magical complete after no-op gate is not the proof

- **WHEN** the candidate FRG pack re-invoke test runs
- **THEN** factory-gate SHALL persist a real-shaped `--from-run` payload
- **AND** the next prepare `complete` SHALL be a consequence of accepted observation of that payload
- **AND** the test SHALL fail if factory-gate is a no-op and prepare returns `complete` anyway

## MODIFIED Requirements

### Requirement: Ship coordinator post-train phases SHALL execute the candidate engine

After `train --merge` is complete or resumed complete, in-engine `pipeline ship` SHALL run Factory Reliability Gate (FRG) pack (`factory-release prepare` and `factory-gate`), `pipeline release`, `release finish`, and any coordinator-invoked tag on the candidate engine bound to the SHA being released. The candidate engine SHALL be the control checkout at that SHA, or an explicit candidate install of that SHA.

When the operator started `pipeline ship` from the previous production-pin CLI, the coordinator SHALL keep that pin process as the durable coordinator and SHALL spawn the candidate engine for leaf post-train verbs (`factory-release prepare`, `factory-gate`, `release`, `release finish`, and `release ensure-tag`). After a successful candidate `factory-gate`, the coordinator SHALL re-invoke the same candidate `factory-release prepare --request <absolute-request.json> --json` once. When that prepare returns `status: "complete"`, the FRG pack phase SHALL return. When that prepare still returns `status: "awaiting_frg_attestation"` because observation is absent or rejected, the FRG pack phase SHALL fail closed and SHALL name unsigned `frg_run_id` `A`, observed `latest.json` `run_id` `B` when present, and the observe miss reason. It SHALL NOT spawn factory-gate again for that unchanged checkpoint. It SHALL NOT return from the FRG pack phase at the first attestation checkpoint. It SHALL NOT treat the later standalone `pipeline release` leaf as a substitute for that complete checkpoint. `release ensure-tag` SHALL run the candidate's `ensureAnnotatedReleaseTag`; it SHALL NOT import that helper from the production-pin process. It SHALL NOT re-exec `pipeline ship`. It SHALL NOT rerun train. It SHALL NOT keep executing those leaf verbs inside the production-pin process when that process source SHA differs from the candidate. Train and `engine-promote` SHALL remain on the production pin.

The coordinator SHALL fail closed before those ship-end verbs if it cannot resolve a matching candidate engine. A failed resolution SHALL persist the train checkpoint and SHALL NOT start FRG pack or release mutation. This requirement does not authorize `--skip-frg` as the default. It does not authorize promote before GitHub Release publication.

#### Scenario: Production-pin ship switches to candidate after train

- **WHEN** an operator runs production-pin `pipeline ship --milestone v1.39.5`
- **AND** train completes with FRG-bound candidate SHA `C` whose version is `1.39.5`
- **THEN** the coordinator SHALL spawn `factory-release prepare` and `pipeline release` on the candidate engine at `C`
- **AND** it SHALL NOT open the release PR using the `1.39.4` production-pin `release.ts`

#### Scenario: Unresolvable candidate stops ship before release

- **WHEN** train is complete
- **AND** the coordinator cannot resolve a candidate engine matching the FRG-bound SHA
- **THEN** ship SHALL stop before `pipeline factory-release prepare` and before `pipeline release`
- **AND** status SHALL name the candidate-engine identity defect
- **AND** persisted train evidence SHALL remain so a retry does not retrain

#### Scenario: Handoff does not re-enter ship or train

- **WHEN** the pin coordinator spawns the candidate for a post-train verb
- **THEN** the spawned argv SHALL be a leaf CLI verb
- **AND** it SHALL NOT be `pipeline ship --milestone`
- **AND** it SHALL NOT be `pipeline train`

#### Scenario: Candidate FRG pack converges prepare after attestation

- **WHEN** candidate `factory-release prepare --request <absolute-request.json> --json` returns `status: "awaiting_frg_attestation"`
- **AND** candidate `factory-gate --for <X.Y.Z> --from-run <loop_run_id>` succeeds
- **THEN** the coordinator SHALL re-invoke the same candidate `factory-release prepare` with that unchanged request once
- **AND** when that prepare returns `status: "complete"`, the FRG pack phase SHALL return
- **AND** when that prepare still returns `status: "awaiting_frg_attestation"`, the FRG pack phase SHALL fail closed
- **AND** it SHALL NOT spawn factory-gate again for that unchanged checkpoint
- **AND** it SHALL NOT treat the later standalone `pipeline release` leaf as a substitute for that complete checkpoint

#### Scenario: Coordinator-invoked tag runs candidate ensure-tag

- **WHEN** the pin coordinator waits for publication after a merged release
- **AND** the pin process SHA differs from the FRG-bound candidate SHA
- **THEN** the coordinator SHALL spawn `release ensure-tag <X.Y.Z> <merge-commit-oid>` on the candidate launcher
- **AND** it SHALL NOT call the production-pin process's imported `ensureAnnotatedReleaseTag`
