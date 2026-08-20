## Purpose

Defines the shared ship-end class law that after a merged release pull request, every composer creates the annotated version tag from on-disk HMAC Factory Reliability Gate (FRG) evidence the Actions tree cannot see, so publication wait can finish without a human `git tag`.

## ADDED Requirements

### Requirement: Ship-end composers SHALL create the annotated tag from on-disk HMAC latest.json after merge

After a ship-end composer has pack-done Factory Reliability Gate (FRG) evidence and has merged the version's release pull request, that composer SHALL invoke `pipeline release ensure-tag <X.Y.Z> <peeled-merge-oid> --packed-candidate <packed-sha>` (or the in-process `ensureAnnotatedReleaseTag` equivalent) on the **candidate** engine **before** publication wait (`wait-release` / `gh release view`). Packed SHA SHALL be factory-release request `integrated_candidate.git_sha` or `ShipTrainEvidence.integrated_head_oid`. The helper SHALL read `.agent-pipeline/frg/<X.Y.Z>/latest.json` from **disk** on the ship host. It SHALL NOT require that file to exist in the git tree. When on-disk `latest.json` is release-eligible (`pass: true` and valid HMAC) and HMAC `candidate_git_sha` equals that independent packed SHA, the helper SHALL create and push annotated tag `vX.Y.Z` on the peeled merge commit of that merged release pull request if the tag is missing. HMAC `candidate_git_sha` SHALL be taken from the same HMAC-validated on-disk snapshot used for release-eligibility; the helper SHALL NOT reopen `latest.json` after that validation. If origin already has an annotated tag that points at that merge commit, the helper SHALL be a successful no-op. A local-only annotated tag SHALL be observed against origin and pushed when origin lacks it. A lightweight or wrong-target existing tag (local or remote) SHALL fail closed. The helper SHALL NOT force-update or delete the tag.

Tugboat and the installed playbook launcher SHALL invoke that CLI verb. They SHALL NOT shell `git tag` or `gh release create`. `pipeline release finish` SHALL remain merge-only. In-engine `pipeline ship` SHALL keep invoking the same helper during publication wait.

This requirement does not authorize `--skip-frg`. It does not authorize committing `.agent-pipeline/frg/`. It does not authorize tagging a SHA other than the peeled merge commit.

#### Scenario: Pack-done plus merged release invokes tag-create before wait-release

- **WHEN** Tugboat has pack-done HMAC `latest.json` for version `1.39.5`
- **AND** `pipeline release finish` has merged the `1.39.5` release pull request with merge commit `M`
- **AND** the git tree has no `.agent-pipeline/frg/1.39.5/latest.json`
- **AND** on-disk `.agent-pipeline/frg/1.39.5/latest.json` is release-eligible
- **THEN** Tugboat SHALL invoke candidate `pipeline release ensure-tag 1.39.5 <peeled M> --packed-candidate <C>` before `wait-release`
- **AND** that helper SHALL create and push annotated tag `v1.39.5` on peeled `M` when the tag is missing

#### Scenario: In-engine ship still tags from disk during publication wait

- **WHEN** in-engine `pipeline ship` has merged the `1.39.5` release pull request
- **AND** on-disk HMAC `latest.json` is release-eligible
- **THEN** publication wait SHALL invoke `ensureAnnotatedReleaseTag` / `release ensure-tag` on the candidate engine
- **AND** it SHALL NOT wait for auto-tag to read tree-file FRG

#### Scenario: Tugboat does not shell git tag

- **WHEN** an automated thinness or composer check inspects Tugboat after this change
- **THEN** the source SHALL contain a candidate `release ensure-tag` invoke after `release finish`
- **AND** it SHALL NOT contain `git tag` or `gh release create` as the tag path

#### Scenario: Missing invoke after pack-done plus merge fails the regression

- **WHEN** a test fixture reports pack-done and a merged release for `X.Y.Z`
- **AND** the tree has no `latest.json`
- **AND** on-disk HMAC `latest.json` is release-eligible
- **AND** the composer never invokes `release ensure-tag` or `ensureAnnotatedReleaseTag`
- **THEN** the test SHALL fail

#### Scenario: Local annotated tag with no remote tag is pushed

- **WHEN** local `refs/tags/v1.39.5` is an annotated tag on the merge commit
- **AND** origin has no `refs/tags/v1.39.5`
- **THEN** `release ensure-tag` SHALL push the verified local tag
- **AND** SHALL NOT treat the local tag as already published

#### Scenario: HMAC candidate SHA comes from the validated snapshot

- **WHEN** `release ensure-tag` validates on-disk `latest.json`
- **THEN** `--packed-candidate` SHALL be compared to `candidate_git_sha` from that HMAC-validated snapshot
- **AND** the helper SHALL NOT reopen `latest.json` after validation

### Requirement: Tag create SHALL fail closed on missing, failed, or unbound on-disk HMAC evidence

`pipeline release ensure-tag` SHALL fail closed and SHALL NOT create or push `vX.Y.Z` when any of these hold:

- on-disk `.agent-pipeline/frg/<X.Y.Z>/latest.json` is missing or unparsable
- `pass` is not true
- HMAC attestation is missing or does not verify
- the supplied OID is not the peeled merge commit of the version's merged release pull request
- HMAC `candidate_git_sha` is missing or is not this ship's Factory Reliability Gate (FRG)-bound packed candidate

The helper SHALL tag the peeled merge commit. It SHALL NOT retarget the tag to the packed candidate when those SHAs differ because the release pull request added commits. It SHALL NOT rewrite `latest.json` so `candidate_git_sha` equals the merge commit. A `candidate_git_sha` that equals neither this ship's packed candidate nor a recorded packed-candidate identity SHALL fail closed. HMAC `candidate_git_sha` SHALL be taken from the same HMAC-validated snapshot used for release-eligibility.

#### Scenario: Missing on-disk latest.json fails closed

- **WHEN** `pipeline release ensure-tag 1.39.5 <merge-oid>` runs
- **AND** on-disk `.agent-pipeline/frg/1.39.5/latest.json` is absent
- **THEN** the command SHALL fail closed
- **AND** it SHALL NOT create or push `v1.39.5`

#### Scenario: pass false fails closed

- **WHEN** on-disk `.agent-pipeline/frg/1.39.5/latest.json` exists with `pass: false`
- **THEN** `release ensure-tag` SHALL fail closed
- **AND** it SHALL NOT create or push `v1.39.5`

#### Scenario: Unrelated merge OID fails closed

- **WHEN** `pipeline release ensure-tag 1.39.5 <oid>` runs
- **AND** `<oid>` is not the peeled merge commit of the v1.39.5 release pull request
- **THEN** the command SHALL fail closed
- **AND** it SHALL NOT create or push `v1.39.5`

#### Scenario: HMAC candidate that is not this ship's packed candidate fails closed

- **WHEN** on-disk `latest.json` for `1.39.5` has a valid HMAC
- **AND** `candidate_git_sha` is a 40-hex SHA that is not this ship's FRG-bound packed candidate
- **THEN** `release ensure-tag` SHALL fail closed
- **AND** it SHALL NOT create or push `v1.39.5`

#### Scenario: Packed candidate SHA may differ from the merge commit

- **WHEN** HMAC `candidate_git_sha` equals this ship's packed candidate `C`
- **AND** the merged release pull request merge commit is `M`
- **AND** `C` and `M` differ because the release pull request added commits
- **AND** on-disk `latest.json` is otherwise release-eligible
- **THEN** `release ensure-tag` SHALL create and push annotated tag `vX.Y.Z` on peeled `M`
- **AND** it SHALL NOT tag `C` instead of `M`
- **AND** it SHALL NOT rewrite `latest.json`

### Requirement: Auto-tag SHALL NOT block the ship when FRG evidence is gitignored

When `.agent-pipeline/frg/` is gitignored and the merged tree has no release-eligible `latest.json` for the detected version, `auto-tag-release` SHALL NOT exit non-zero for that missing tree-file. It SHALL NOT create a tag without HMAC evidence. Local `release ensure-tag` remains the source of truth for tag create. When `refs/tags/vX.Y.Z` already exists on the remote, auto-tag SHALL remain a successful no-op. When FRG is not gitignored, auto-tag SHALL keep fail-closing on missing or failed tree-file `latest.json`.

Publication wait SHALL succeed after the local tag push plus GitHub Release publication. It SHALL NOT require a human `git tag`.

#### Scenario: Gitignored missing tree latest.json does not fail auto-tag

- **WHEN** a release merge for `1.39.5` is detected
- **AND** `.agent-pipeline/frg/` is gitignored
- **AND** the Actions tree has no `.agent-pipeline/frg/1.39.5/latest.json`
- **AND** `v1.39.5` does not already exist
- **THEN** auto-tag SHALL exit 0 without creating a tag
- **AND** it SHALL NOT fail closed solely because tree-file `latest.json` is absent

#### Scenario: Existing remote tag remains a successful no-op

- **WHEN** a release merge for `1.39.5` is detected
- **AND** `refs/tags/v1.39.5` already exists on the remote
- **THEN** auto-tag SHALL exit 0
- **AND** SHALL NOT force-update or delete the tag

#### Scenario: Non-gitignored missing tree latest.json still fail-closes

- **WHEN** a release merge for `1.39.5` is detected
- **AND** `.agent-pipeline/frg/` is not gitignored
- **AND** tree-file `.agent-pipeline/frg/1.39.5/latest.json` is missing
- **AND** `v1.39.5` does not already exist
- **THEN** auto-tag SHALL exit non-zero
- **AND** SHALL NOT create or push `v1.39.5`

#### Scenario: wait-release succeeds after local tag and GitHub Release

- **WHEN** candidate `release ensure-tag` has pushed annotated `v1.39.5`
- **AND** `release.yml` has published GitHub Release `v1.39.5` as non-draft
- **THEN** Tugboat `wait-release` SHALL observe that release via `gh release view v1.39.5`
- **AND** it SHALL proceed to `engine-promote`
- **AND** it SHALL NOT require a human `git tag`

#### Scenario: Auto-tag still fail-closing on gitignored tree file fails the regression

- **WHEN** a workflow or unit test inspects auto-tag for a gitignored missing tree `latest.json`
- **AND** the workflow still exits non-zero for that case
- **THEN** the test SHALL fail

### Requirement: Next identical gitignored-FRG missing-tag fault SHALL need no new mole

When a later ship packs HMAC `latest.json` on disk, merges the release pull request, and leaves `.agent-pipeline/frg/` gitignored, the same composer SHALL invoke `release ensure-tag`, the same auto-tag gate SHALL not fail the job for missing tree-file FRG, and `wait-release` SHALL be able to succeed after GitHub Release publication. The fault SHALL NOT require a new path-local mole issue.

#### Scenario: Later version reuses the same tag path

- **WHEN** a later ship for `1.40.0` has on-disk HMAC `latest.json` and a merged release pull request
- **AND** `.agent-pipeline/frg/` is gitignored
- **THEN** the same composer SHALL invoke candidate `release ensure-tag` before publication wait
- **AND** auto-tag SHALL NOT fail the job solely because tree-file `latest.json` is absent
- **AND** the fault SHALL NOT require a new mole issue
