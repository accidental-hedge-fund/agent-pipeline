## ADDED Requirements

### Requirement: Factory-release prepare attestation observe SHALL return accepted, absent, or rejected

`pipeline factory-release prepare` attestation observation SHALL return a typed result of **accepted**, **absent**, or **rejected**. It SHALL NOT fuse rejected HMAC `--from-run` evidence into the same null as a missing file.

**Accepted** SHALL mean HMAC-pass evidence whose top-level `factory_release_binding` matches the closed unsigned checkpoint (`A`, request fingerprint, target version, integrated candidate SHA, pack identity, pack run ID, loop run ID, and every unsigned artifact digest), and whose version and loop match that checkpoint. Attested `run_id` MAY be `B` distinct from `A`. Presence of valid `pack_provenance` SHALL NOT prevent accepted.

**Absent** SHALL mean the evidence file is missing, unreadable, or unparsable.

**Rejected** SHALL mean the file is present but HMAC fails, `factory_release_binding` is missing, the binding mismatches, the only binding carrier is notes or inferred provenance, or `pack_provenance` fails its own validation. Rejected SHALL carry a stable reason code plus expected unsigned `frg_run_id` `A` and observed `run_id` `B` when those identities are known.

Observation SHALL NOT accept solely because `pack_provenance` is present. Observation SHALL NOT require `evidence.run_id === unsigned.frg_run_id` when the HMAC-covered binding names `A`. A present invalid top-level binding SHALL NOT fall back to notes or `pack_provenance`.

Unsigned prepare SHALL NOT overlay `factory_release_binding` after sign in order to convert rejected into accepted.

#### Scenario: HMAC from-run latest.json with distinct B is accepted

- **WHEN** unsigned checkpoint `frg_run_id` is `A`
- **AND** HMAC `latest.json` has `run_id` `B`, valid `pack_provenance`, and HMAC-covered `factory_release_binding` matching `A` and the closed digests
- **THEN** observation SHALL return accepted
- **AND** it SHALL NOT return absent solely because `run_id` is not `A`
- **AND** it SHALL NOT return absent solely because `pack_provenance` is present

#### Scenario: From-run payload without binding is rejected

- **WHEN** unsigned checkpoint `frg_run_id` is `A`
- **AND** HMAC `latest.json` has `run_id` `B` and `pack_provenance` and no top-level `factory_release_binding`
- **THEN** observation SHALL return rejected
- **AND** the reason SHALL name the missing binding
- **AND** it SHALL NOT be treated as success

#### Scenario: Notes-only binding is rejected

- **WHEN** HMAC `latest.json` carries `factory_release_binding` only as a notes string
- **AND** the top-level field is absent
- **THEN** observation SHALL return rejected
- **AND** it SHALL NOT parse notes as the authoritative join to `A`

#### Scenario: Missing latest.json is absent

- **WHEN** unsigned artifacts exist
- **AND** `.agent-pipeline/frg/<X.Y.Z>/latest.json` is missing
- **THEN** observation SHALL return absent
- **AND** prepare SHALL return `status: "awaiting_frg_attestation"`

### Requirement: Factory-release prepare SHALL complete on accepted bound B

When attestation observation returns **accepted** for HMAC-pass `--from-run` evidence whose `run_id` is `B` and whose `factory_release_binding.frg_run_id` equals closed unsigned `A`, `pipeline factory-release prepare` SHALL treat that attestation as production-owned for the unchanged request. It SHALL invoke shared `runRelease` and SHALL return `status: "complete"` with the attested run identity. It SHALL NOT stay `awaiting_frg_attestation` solely because `evidence.run_id !== unsigned.frg_run_id`. It SHALL NOT return `attestation_mismatch` solely for that `A`/`B` inequality when the HMAC-covered binding matches.

When observation returns **absent**, prepare SHALL return `status: "awaiting_frg_attestation"` with the closed unsigned identities.

When observation returns **rejected**, prepare SHALL still return `status: "awaiting_frg_attestation"` (prepare remains uncredentialed) and SHALL include the observe miss (reason code, unsigned `A`, observed `B` when present) on that awaiting result so the composer can fail closed after its attest allowance.

Complete JSON MAY record attested `run_id` `B`. The unsigned checkpoint SHALL keep `frg_run_id` `A`. Repeated calls at the proved complete checkpoint SHALL NOT create a second pack, attestation, branch, or pull request.

#### Scenario: Second prepare call completes after bound from-run

- **WHEN** the trusted attestor has stored HMAC-pass `latest.json` with `run_id` `B` and `factory_release_binding` matching unsigned `A`
- **AND** a later `factory-release prepare` uses the unchanged request
- **THEN** the command SHALL return `status: "complete"`
- **AND** it SHALL NOT remain `awaiting_frg_attestation` because `run_id` is `B`

#### Scenario: Rejected observe stays awaiting and names the miss

- **WHEN** observation returns rejected for `latest.json` `run_id` `B` against unsigned `A`
- **THEN** prepare SHALL return `status: "awaiting_frg_attestation"`
- **AND** that result SHALL include the observe miss reason and both identities when known
- **AND** it SHALL NOT overlay `factory_release_binding` after sign
