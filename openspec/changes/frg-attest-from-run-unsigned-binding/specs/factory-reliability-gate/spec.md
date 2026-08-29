## ADDED Requirements

### Requirement: Credentialed from-run SHALL HMAC-bind attestor identity B to unsigned checkpoint A

Credentialed `pipeline factory-gate --for <X.Y.Z> --from-run <loop_run_id>` (and the in-process equivalent) on a ship-path score SHALL treat the closed unsigned Factory Reliability Gate (FRG) checkpoint as identity `A` and the attested evidence `run_id` as identity `B`. `A` and `B` SHALL remain distinct. The attestor SHALL create typed top-level `factory_release_binding` on the evidence object **before** it calculates HMAC. Unsigned `factory-release prepare` and ship SHALL NOT add or overlay that field after sign.

The HMAC-covered binding SHALL exactly match request fingerprint, target version, integrated candidate SHA, pack identity, pack run ID, loop run ID, unsigned `frg_run_id` `A`, and every closed unsigned artifact digest. `B` SHALL be a deterministic, idempotent function of that complete checkpoint binding. Reprocessing unchanged `A` SHALL resolve to the same `B`. The attestor SHALL NOT mint `B` from a timestamp or random nonce on this path.

`pack_provenance` SHALL remain subject to its normal validation. Its presence SHALL NOT substitute for `factory_release_binding`. Notes and inferred provenance SHALL NOT be authoritative binding carriers. A ship-path `--from-run` that cannot load a complete unsigned checkpoint, or that would write HMAC-pass `latest.json` without the binding, SHALL fail closed and SHALL NOT persist that file.

Before HMAC, the attestor SHALL require every collected scored candidate identity (`pack_provenance.candidate_git_sha` and Layer-A `pack_provenance.probes[].candidate_git_sha` when present) to exactly equal `factory_release_binding.candidate_git_sha`. A mismatch SHALL fail closed and SHALL NOT persist evidence.

Standalone unbound `--from-run` (no unsigned checkpoint / no version index / no request SHA) MAY omit the binding and MAY mint a fresh `run_id`. That standalone path SHALL NOT be the ship handoff.

This requirement does not collapse production `A` and `B` into one `run_id`. It does not authorize `--skip-frg`. It does not change Layer A packed-candidate identity (#1298).

#### Scenario: From-run writes HMAC binding before sign

- **WHEN** uncredentialed prepare has closed unsigned `frg_run_id` `A` for version `X.Y.Z` and loop `L`
- **AND** credentialed `factory-gate --for X.Y.Z --from-run L` scores that bound pack
- **THEN** `.agent-pipeline/frg/X.Y.Z/latest.json` SHALL include top-level `factory_release_binding` that names `A` and the closed unsigned digests
- **AND** HMAC SHALL cover that binding
- **AND** attested `run_id` SHALL be `B` distinct from `A`

#### Scenario: Unchanged checkpoint remints the same B

- **WHEN** credentialed `--from-run` has already written HMAC `latest.json` with `run_id` `B` for unsigned checkpoint `A`
- **AND** a later `--from-run` scores the same unchanged complete checkpoint binding
- **THEN** attested `run_id` SHALL still be `B`
- **AND** it SHALL NOT mint a new identity `B2`

#### Scenario: Ship-path from-run without unsigned checkpoint fails closed

- **WHEN** a ship-path `--from-run` score has no complete unsigned checkpoint for that version and loop
- **THEN** the attestor SHALL fail closed
- **AND** it SHALL NOT persist HMAC-pass `latest.json` without `factory_release_binding`

#### Scenario: Notes are not a binding carrier

- **WHEN** HMAC `latest.json` has `run_id` `B` and a notes entry `factory_release_binding:<json>`
- **AND** top-level `factory_release_binding` is absent
- **THEN** that artifact SHALL NOT count as HMAC-bound to unsigned `A`

#### Scenario: Overlay after sign still fails HMAC

- **WHEN** credentialed `--from-run` has HMAC-signed `latest.json` with `factory_release_binding` for `A`
- **AND** a writer adds or changes `factory_release_binding` after sign
- **THEN** HMAC verification SHALL fail
- **AND** unsigned prepare and ship SHALL NOT be the writers of that overlay

#### Scenario: From-run refuses scored candidate that differs from the bound candidate

- **WHEN** credentialed `--from-run` loads `factory_release_binding.candidate_git_sha` `C`
- **AND** collected `pack_provenance.candidate_git_sha` is `D` distinct from `C`
- **THEN** the attestor SHALL fail closed
- **AND** it SHALL NOT persist HMAC-pass `latest.json`

### Requirement: Pack provenance presence SHALL NOT reject a bound from-run attestation

Factory Reliability Gate (FRG) attestation observation SHALL NOT treat `pack_provenance != null` as sufficient grounds to reject HMAC-pass `--from-run` evidence. `pack_provenance` SHALL still fail closed when its own validation fails. `pack_provenance` SHALL NOT substitute for HMAC-covered `factory_release_binding`. A from-run score that includes both `pack_provenance` and a matching `factory_release_binding` SHALL remain observable as accepted when the rest of the binding holds.

#### Scenario: HMAC from-run latest.json with pack_provenance is observable

- **WHEN** unsigned checkpoint `frg_run_id` is `A`
- **AND** HMAC `latest.json` `run_id` is `B` for the same loop and integrated candidate
- **AND** that file has `pack_provenance` and HMAC-covered `factory_release_binding` matching `A`
- **THEN** observation SHALL accept that file
- **AND** it SHALL NOT return absent solely because `pack_provenance` is present
- **AND** it SHALL NOT return absent solely because `run_id` is not `A`

#### Scenario: Pack provenance cannot replace the binding

- **WHEN** HMAC `latest.json` has `run_id` `B` and `pack_provenance` for the bound loop and candidate
- **AND** top-level `factory_release_binding` is absent
- **THEN** observation SHALL reject that file
- **AND** it SHALL NOT treat `pack_provenance` as the join to unsigned `A`

### Requirement: Ship-path FRG pack composers SHALL attest an unchanged checkpoint at most once

A ship-path Factory Reliability Gate (FRG) pack composer (Tugboat, the installed `pipeline-ship-playbook` copy, in-engine `pipeline ship`, or any later composer of the same durable prepare protocol) SHALL invoke credentialed `pipeline factory-gate --for <X.Y.Z> --from-run <loop_run_id>` at most once for an unchanged complete unsigned checkpoint binding. After that attestor child exits 0, the composer SHALL re-observe (in-engine: re-invoke the same uncredentialed `factory-release prepare` request once). An absent or rejected observation after that tick SHALL fail the pack phase. The fail-closed message SHALL name unsigned `frg_run_id` `A`, observed `latest.json` `run_id` `B` when present, and the observe miss reason. The composer SHALL NOT spawn another factory-gate for that unchanged binding. A changed complete checkpoint binding SHALL create a new deterministic attestor identity and SHALL reset the allowance.

`"retry"` while the bound pack loop is live SHALL keep the existing live-loop wait law. This requirement does not authorize `--skip-frg`. It does not return from the pack phase at the first `awaiting_frg_attestation` checkpoint.

#### Scenario: Second attest spawn for unchanged A is forbidden

- **WHEN** a composer has already spawned factory-gate once for unsigned checkpoint `A`
- **AND** the next prepare tick is still `awaiting_frg_attestation` for that same complete checkpoint binding
- **THEN** the composer SHALL fail the FRG pack phase
- **AND** it SHALL NOT spawn factory-gate again for `A`

#### Scenario: Changed checkpoint resets the attest allowance

- **WHEN** prepare later returns a new unsigned `frg_run_id` `A'` whose complete checkpoint binding differs from `A`
- **THEN** the composer SHALL allow one attestor spawn for `A'`
- **AND** the attestor SHALL mint deterministic `B'` for that new binding

#### Scenario: Regression fails if attest ticks are uncapped

- **WHEN** an automated check drives unsigned `A`, a `--from-run` payload with `run_id` `B` plus `pack_provenance` and no `factory_release_binding`, and composer `"attest"` ticks
- **THEN** the check SHALL fail if observation is treated as success
- **AND** the check SHALL fail if the pack phase never terminates
