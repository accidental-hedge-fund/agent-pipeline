## MODIFIED Requirements

### Requirement: Candidate ensure-tag SHALL prove the supplied OID is the merged release

`pipeline release ensure-tag` SHALL re-observe the version's release PR before creating a missing annotated tag. It SHALL require that pull request to be merged with a merge commit exactly equal to the supplied OID. It SHALL fail closed and SHALL NOT create or push `v<X.Y.Z>` when that proof is absent. Before creating a missing tag it SHALL also validate on-disk `.agent-pipeline/frg/<X.Y.Z>/latest.json` as release-eligible (`pass: true` and valid HMAC) and SHALL require HMAC `candidate_git_sha` to equal this ship's Factory Reliability Gate (FRG)-bound packed candidate. It SHALL NOT require that packed candidate SHA to equal the merge commit. It SHALL NOT rewrite `latest.json`. It SHALL NOT require the file to exist in the git tree.

#### Scenario: Unrelated OID is rejected

- **WHEN** `pipeline release ensure-tag 1.39.5 <oid>` runs
- **AND** `<oid>` is a valid 40-hex commit
- **AND** the v1.39.5 release PR merge commit is a different OID
- **THEN** the command SHALL fail closed
- **AND** it SHALL NOT create or push `v1.39.5`

#### Scenario: Missing on-disk HMAC latest.json is rejected

- **WHEN** `pipeline release ensure-tag 1.39.5 <merge-oid>` runs
- **AND** the merge OID is the v1.39.5 release PR merge commit
- **AND** on-disk `.agent-pipeline/frg/1.39.5/latest.json` is absent
- **THEN** the command SHALL fail closed
- **AND** it SHALL NOT create or push `v1.39.5`

#### Scenario: Unbound HMAC candidate_git_sha is rejected

- **WHEN** on-disk `latest.json` is otherwise release-eligible
- **AND** `candidate_git_sha` is not this ship's FRG-bound packed candidate
- **THEN** the command SHALL fail closed
- **AND** it SHALL NOT create or push `v1.39.5`

## ADDED Requirements

### Requirement: In-engine publication wait SHALL tag from on-disk HMAC before polling GitHub Release

In-engine `pipeline ship` publication wait SHALL invoke candidate `ensureAnnotatedReleaseTag` / `release ensure-tag` against on-disk HMAC `latest.json` before polling GitHub Release. A missing tree-file `latest.json` SHALL NOT skip that invoke. Publication wait SHALL still require a published non-draft GitHub Release after the tag exists.

#### Scenario: Disk evidence with no tree file still tags

- **WHEN** in-engine ship has merged the `1.39.5` release pull request
- **AND** on-disk HMAC `latest.json` is release-eligible
- **AND** the git tree has no `.agent-pipeline/frg/1.39.5/latest.json`
- **THEN** publication wait SHALL invoke ensure-tag on the candidate engine
- **AND** it SHALL NOT skip tagging because auto-tag cannot see the tree file
