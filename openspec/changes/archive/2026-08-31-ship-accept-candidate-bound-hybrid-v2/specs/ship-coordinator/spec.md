## ADDED Requirements

### Requirement: Ship FRG observation SHALL accept candidate-bound hybrid-v2 after v1.33.0

Ship Factory Reliability Gate (FRG) observation SHALL reuse the shared FRG release-eligibility validator for `.agent-pipeline/frg/<X.Y.Z>/latest.json`. After that validator accepts the artifact, observation SHALL bind it to the ship intent, the integrated train candidate, and the closed factory-release checkpoint. Observation SHALL NOT duplicate the validator's policy, manifest, fingerprint, proof-matrix, or HMAC checks.

For a target version after `1.33.0`, observation SHALL accept the artifact only when all of the following hold:

- `pack_provenance.policy_id` is `factory-gate-v1-hybrid-v2`
- HMAC-covered top-level `factory_release_binding` is present
- that binding fully matches the closed unsigned checkpoint
- `pack_provenance` repository, base branch, and candidate SHA match the ship intent and the integrated train candidate
- `factory_release_binding.candidate_git_sha` equals that same train candidate

Presence of valid `pack_provenance` SHALL NOT cause rejection. Historical `1.33.0` observation SHALL keep its current acceptance: hybrid-v1 remains valid only for exactly `1.33.0`; a matching `pack_provenance` on `1.33.0` SHALL still bind the train candidate, repository, and base branch.

Observation SHALL compare the binding to the closed checkpoint with the existing unsigned-digest binding comparison. It SHALL NOT invent a second binding schema. When the closed checkpoint is missing, malformed, or in conflict after a post-pilot eligible read, observation SHALL fail closed. It SHALL NOT accept the artifact by reading only a version-index candidate SHA.

#### Scenario: v1.40.0 hybrid-v2 with matching checkpoint is observed

- **WHEN** train observation has proven integrated candidate `C`
- **AND** `.agent-pipeline/frg/1.40.0/latest.json` is HMAC-pass, `pass: true`, `pack_provenance.policy_id` is `factory-gate-v1-hybrid-v2`, `pack_provenance.candidate_git_sha` is `C`, and HMAC-covered `factory_release_binding` matches the closed checkpoint for `C`
- **THEN** ship FRG observation SHALL return that evidence
- **AND** ship SHALL proceed to the next phase after `frg_pack`
- **AND** it SHALL NOT throw `hybrid pack_provenance is valid only for v1.33.0`

#### Scenario: Observed v1.39.16 and v1.40.0 rejection shapes no longer reject hybrid-v2

- **WHEN** a unit test feeds the v1.39.16 or v1.40.0 ship-observe rejection shape (HMAC-pass hybrid-v2 `pack_provenance` present, version not `1.33.0`, matching candidate and checkpoint)
- **THEN** the test SHALL fail if observation throws `hybrid pack_provenance is valid only for v1.33.0; got 1.39.16` or `got 1.40.0`
- **AND** after the fix the same input SHALL be accepted

#### Scenario: Historical v1.33.0 matching provenance remains accepted

- **WHEN** ship FRG observation runs for version `1.33.0`
- **AND** release-eligible `latest.json` has `pack_provenance` whose candidate SHA, repository, and base branch match the train and intent
- **THEN** observation SHALL return that evidence
- **AND** it SHALL NOT require a post-pilot `factory_release_binding` solely because `pack_provenance` is present

### Requirement: Ship FRG observation SHALL fail closed on post-pilot hybrid-v1, unknown policy, or unbound hybrid-v2

Ship FRG observation SHALL fail closed for a target version after `1.33.0` when release-eligible `latest.json` carries historical hybrid-v1 (`factory-gate-v1-hybrid-v1`), an unknown `pack_provenance.policy_id`, missing `factory_release_binding`, notes-only binding, or a binding that does not fully match the closed checkpoint. The fail-closed message SHALL name the mismatched `policy_id` or the mismatched `factory_release_binding` field. Observation SHALL NOT fall back to `pack_provenance` as the join to the checkpoint. Observation SHALL NOT accept provenance-free post-pilot evidence. Repository, base, candidate, release, manifest, and HMAC defects SHALL continue to fail closed. Unauthenticated `factory_release_binding` overlay SHALL fail HMAC in the shared validator and SHALL NOT become observed ship evidence.

#### Scenario: Hybrid-v1 after v1.33.0 fails closed

- **WHEN** the ship version is `1.40.0` or any other version after `1.33.0`
- **AND** `pack_provenance.policy_id` is `factory-gate-v1-hybrid-v1`
- **THEN** observation SHALL fail closed
- **AND** the message SHALL name that policy id
- **AND** it SHALL NOT return the evidence

#### Scenario: Missing or notes-only binding fails closed

- **WHEN** HMAC-pass hybrid-v2 `latest.json` for a post-pilot ship has no top-level `factory_release_binding`
- **OR** the only binding carrier is a notes string
- **THEN** observation SHALL fail closed
- **AND** the message SHALL name `factory_release_binding`
- **AND** it SHALL NOT treat `pack_provenance` as the checkpoint join

#### Scenario: Checkpoint-mismatched binding fails closed

- **WHEN** HMAC-pass hybrid-v2 `latest.json` for a post-pilot ship has top-level `factory_release_binding`
- **AND** that binding differs from the closed unsigned checkpoint in request fingerprint, target version, candidate SHA, pack identity, pack run id, loop run id, unsigned `frg_run_id`, or an unsigned artifact digest
- **THEN** observation SHALL fail closed
- **AND** the message SHALL name the mismatched binding field
- **AND** it SHALL NOT return the evidence

#### Scenario: Unknown policy, identity mismatch, and invalid HMAC stay fail-closed

- **WHEN** `pack_provenance.policy_id` is unknown, or repository / base / candidate / release / manifest identity does not match the ship intent and train, or HMAC verification fails
- **THEN** observation SHALL NOT accept the artifact
- **AND** HMAC or other release-eligibility failure SHALL remain not-observed (`null`) per the existing observe-null mapping
- **AND** identity defects after a valid eligible read SHALL still throw

#### Scenario: Provenance-free post-pilot evidence is not rebound from the version index

- **WHEN** the ship version is after `1.33.0`
- **AND** release-eligible observation would otherwise proceed without hybrid `pack_provenance`
- **THEN** observation SHALL fail closed
- **AND** it SHALL NOT accept a candidate SHA read only from `.agent-pipeline/factory-release/by-version/<X.Y.Z>.json`
