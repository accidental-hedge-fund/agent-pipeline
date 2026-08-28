## ADDED Requirements

### Requirement: Ship FRG observation SHALL return null when latest.json is not yet release-eligible

Ship FRG observation SHALL return null when `.agent-pipeline/frg/<X.Y.Z>/latest.json` is absent, unreadable, or not release-eligible for the ship version. After train observation has proven the integrated candidate and no later ship phase has run, coordinator `next_action` SHALL be `frg_pack`. Observation SHALL NOT throw the tag-path fail-closed message that names `Cannot create or push tag`. Observation returning null SHALL NOT skip a later ensure-tag or publication phase. Candidate-identity defects during observation (base advanced after the recorded train, recorded train not contained in base, HMAC candidate SHA mismatch after a valid eligible read) SHALL still fail closed.

#### Scenario: Missing latest.json is not observed, not a tag-path throw

- **WHEN** train observation has returned complete evidence for the planned issues
- **AND** `.agent-pipeline/frg/1.39.14/latest.json` is absent
- **AND** the FRG attestation key is presented
- **THEN** ship FRG observation SHALL return null
- **AND** coordinator `next_action` SHALL be `frg_pack`
- **AND** ship SHALL NOT throw a message that says `Cannot create or push tag v1.39.14`
- **AND** ship SHALL NOT leave `next_action` at `train_merge` solely because that file is absent

#### Scenario: Unreadable or not-eligible latest.json is not observed

- **WHEN** train observation has returned complete evidence
- **AND** `.agent-pipeline/frg/1.39.14/latest.json` is unreadable, unparsable, `pass: false`, or otherwise not release-eligible
- **THEN** ship FRG observation SHALL return null
- **AND** coordinator `next_action` SHALL be `frg_pack`
- **AND** ship SHALL NOT skip FRG pack solely because that file is present but ineligible

#### Scenario: Observe-null does not skip later tagging

- **WHEN** ship FRG observation has returned null because `latest.json` was absent or ineligible
- **AND** a later tick observes a release-eligible `latest.json` for that version
- **THEN** observation SHALL return that evidence
- **AND** publication / `release ensure-tag` SHALL still fail closed unless that artifact is release-eligible
- **AND** ship SHALL NOT omit ensure-tag because an earlier observe returned null

#### Scenario: Candidate identity defects still fail closed during observe

- **WHEN** ship FRG observation runs against a recorded train candidate
- **AND** base has advanced past that candidate, the candidate is no longer contained in base, or a valid eligible `latest.json` has HMAC `candidate_git_sha` that is not that candidate
- **THEN** observation SHALL fail closed
- **AND** it SHALL NOT return null
- **AND** it SHALL NOT start FRG pack on that drifted identity
