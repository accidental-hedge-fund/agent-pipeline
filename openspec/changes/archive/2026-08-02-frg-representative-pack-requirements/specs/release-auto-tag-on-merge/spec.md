## ADDED Requirements

### Requirement: Auto-tag SHALL verify passing FRG evidence before creating or pushing a tag

The auto-tag workflow SHALL verify that a **passing, release-eligible** Factory Reliability Gate
(FRG) evidence artifact exists for version `X.Y.Z` in the checked-out tree before creating or
pushing the annotated tag on a detected release merge (subject matches `release: X.Y.Z — …` and
`core/package.json` version equals `X.Y.Z`, and tag `vX.Y.Z` does not already exist). Lookup
SHALL use the same stable path convention as the release command
(`.agent-pipeline/frg/<X.Y.Z>/latest.json` or the documented equivalent). Validation SHALL reject
missing files, unparsable JSON, `pass: false`, empty `run_id`, missing live-loop provenance
required for release-eligible pass, missing or invalid HMAC attestation (producer key
`PIPELINE_FRG_ATTESTATION_KEY` — self-consistent hand-authored JSON without the secret SHALL
NOT tag), and other release-eligibility failures defined by the `factory-reliability-gate`
capability (including representative pack composition when encoded on the artifact). On
validation failure the workflow SHALL exit non-zero and SHALL NOT create or push any tag. On
validation success the workflow MAY proceed to resolve notes and push the annotated tag as
already specified. Non-release pushes remain successful no-ops and SHALL NOT require FRG
evidence. The FRG check SHALL NOT merge pull requests, enable auto-merge, or substitute for
human ownership of the release merge itself.

#### Scenario: Missing FRG evidence blocks the tag

- **WHEN** a release merge for `1.30.0` is detected (subject and package version match)
- **AND** no FRG evidence artifact for `1.30.0` is present in the tree (or lookup path is empty)
- **THEN** the workflow SHALL exit non-zero
- **AND** SHALL NOT create or push `v1.30.0`

#### Scenario: Failed FRG evidence blocks the tag

- **WHEN** a release merge for `1.30.0` is detected
- **AND** `.agent-pipeline/frg/1.30.0/latest.json` exists with `pass: false` (or fails
  release-eligibility validation)
- **THEN** the workflow SHALL exit non-zero
- **AND** SHALL NOT create or push `v1.30.0`

#### Scenario: Passing release-eligible FRG allows tag proceed

- **WHEN** a release merge for `1.30.0` is detected
- **AND** FRG evidence for `1.30.0` is present, parseable, `pass: true`, and release-eligible
- **AND** the HMAC attestation verifies under `PIPELINE_FRG_ATTESTATION_KEY`
- **AND** `v1.30.0` does not already exist on the remote
- **THEN** the workflow SHALL proceed to create and push the annotated tag (subject to existing
  notes-resolution and `RELEASE_TAG_TOKEN` rules)

#### Scenario: Hand-authored self-consistent FRG without producer MAC blocks the tag

- **WHEN** a release merge for `1.30.0` is detected
- **AND** `.agent-pipeline/frg/1.30.0/latest.json` is internally consistent (fingerprints,
  composition, live loop fields) but `integrity.attestation` is missing or its MAC does not
  verify under `PIPELINE_FRG_ATTESTATION_KEY`
- **THEN** the workflow SHALL exit non-zero
- **AND** SHALL NOT create or push `v1.30.0`

#### Scenario: Non-release push still no-ops without FRG

- **WHEN** a non-release commit is pushed to the default branch
- **THEN** the workflow SHALL exit as a successful no-op without requiring FRG evidence
- **AND** SHALL create no tag

#### Scenario: FRG check is drift-guarded

- **WHEN** the auto-tag workflow tests inspect the workflow definition
- **THEN** they SHALL assert that a step validates FRG evidence for the detected version before
  the tag-create/push step
- **AND** removing that validation SHALL fail the drift-guard test
