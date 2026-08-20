## MODIFIED Requirements

### Requirement: Candidate ensure-tag SHALL prove the supplied OID is the merged release

`pipeline release ensure-tag` SHALL re-observe the version's release PR before creating a missing annotated tag. It SHALL require that pull request to be merged with a merge commit exactly equal to the supplied OID. It SHALL fail closed and SHALL NOT create or push `v<X.Y.Z>` when that proof is absent. Before creating a missing tag it SHALL also validate on-disk `.agent-pipeline/frg/<X.Y.Z>/latest.json` as release-eligible (`pass: true` and valid HMAC) and SHALL require HMAC `candidate_git_sha` (`factory_release_binding.candidate_git_sha` if present, else `pack_provenance.candidate_git_sha`) to equal the caller-supplied `--packed-candidate` 40-hex SHA. That packed SHA SHALL be this ship's independent Factory Reliability Gate (FRG)-bound identity: factory-release request `integrated_candidate.git_sha` or `ShipTrainEvidence.integrated_head_oid`. The HMAC artifact SHALL NOT be the authority for "this ship." The command SHALL fail closed when `--packed-candidate` is missing or is not 40-hex. It SHALL NOT require that packed candidate SHA to equal the merge commit. It SHALL NOT rewrite `latest.json`. It SHALL NOT require the file to exist in the git tree.

An existing `v<X.Y.Z>` SHALL succeed only when it is an annotated tag whose peeled commit equals the merge commit. A lightweight tag or a tag on a different commit SHALL fail closed. The command SHALL NOT force-update or delete the tag. If a concurrent push creates the remote tag, the command SHALL re-observe origin and succeed only if that tag is the correct annotated tag on the merge commit.

#### Scenario: Unrelated OID is rejected

- **WHEN** `pipeline release ensure-tag 1.39.5 <oid> --packed-candidate <C>` runs
- **AND** `<oid>` is a valid 40-hex commit
- **AND** the v1.39.5 release PR merge commit is a different OID
- **THEN** the command SHALL fail closed
- **AND** it SHALL NOT create or push `v1.39.5`

#### Scenario: Missing on-disk HMAC latest.json is rejected

- **WHEN** `pipeline release ensure-tag 1.39.5 <merge-oid> --packed-candidate <C>` runs
- **AND** the merge OID is the v1.39.5 release PR merge commit
- **AND** on-disk `.agent-pipeline/frg/1.39.5/latest.json` is absent
- **THEN** the command SHALL fail closed
- **AND** it SHALL NOT create or push `v1.39.5`

#### Scenario: Unbound HMAC candidate_git_sha is rejected

- **WHEN** on-disk `latest.json` is otherwise release-eligible
- **AND** `--packed-candidate` is this ship's `integrated_candidate.git_sha` `C`
- **AND** HMAC `candidate_git_sha` is a 40-hex SHA that is not `C`
- **THEN** the command SHALL fail closed
- **AND** it SHALL NOT create or push `v1.39.5`

#### Scenario: Packed candidate may differ from the merge commit

- **WHEN** `--packed-candidate` is `C`
- **AND** HMAC `candidate_git_sha` equals `C`
- **AND** the merged release PR merge commit is `M`
- **AND** `C` and `M` differ
- **THEN** the command SHALL create and push annotated tag `v1.39.5` on peeled `M`
- **AND** it SHALL NOT tag `C` instead of `M`

#### Scenario: Wrong existing tag fails closed

- **WHEN** `refs/tags/v1.39.5` already exists as a lightweight tag or peels to a commit other than the merge
- **THEN** the command SHALL fail closed
- **AND** it SHALL NOT force-update or delete the tag

## ADDED Requirements

### Requirement: In-engine publication wait SHALL tag from on-disk HMAC before polling GitHub Release

In-engine `pipeline ship` publication wait SHALL invoke candidate `ensureAnnotatedReleaseTag` / `release ensure-tag` against on-disk HMAC `latest.json` before polling GitHub Release. A missing tree-file `latest.json` SHALL NOT skip that invoke. Publication wait SHALL still require a published non-draft GitHub Release after the tag exists.

#### Scenario: Disk evidence with no tree file still tags

- **WHEN** in-engine ship has merged the `1.39.5` release pull request
- **AND** on-disk HMAC `latest.json` is release-eligible
- **AND** the git tree has no `.agent-pipeline/frg/1.39.5/latest.json`
- **THEN** publication wait SHALL invoke ensure-tag on the candidate engine
- **AND** it SHALL NOT skip tagging because auto-tag cannot see the tree file
