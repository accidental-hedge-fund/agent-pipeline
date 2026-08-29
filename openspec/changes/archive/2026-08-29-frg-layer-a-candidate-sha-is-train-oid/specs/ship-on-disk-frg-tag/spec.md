## ADDED Requirements

### Requirement: Ensure-tag SHALL accept HMAC bound to packed candidate C when control HEAD is pin P

`pipeline release ensure-tag` (and `ensureAnnotatedReleaseTag`) for packed candidate `C` SHALL accept on-disk HMAC `latest.json` whose bound `candidate_git_sha` is `C` when that evidence was scored on candidate engine sources for `C`. Control-checkout HEAD equal to a different production pin `P` SHALL NOT cause the helper to throw `HMAC candidate_git_sha is not this ship's packed candidate`. The helper SHALL still fail closed when HMAC `candidate_git_sha` is `P` (or any SHA that is not this ship's packed candidate `C`). The helper SHALL NOT skip HMAC. The helper SHALL NOT rewrite `latest.json` so `candidate_git_sha` equals `P` or the merge commit. The helper SHALL NOT require the operator to fast-forward the control checkout to `C` before tag create.

#### Scenario: HMAC bound to packed C is accepted while control HEAD is pin P

- **WHEN** on-disk HMAC `latest.json` is release-eligible
- **AND** HMAC `candidate_git_sha` equals this ship's packed candidate `C`
- **AND** that score ran on candidate engine sources for `C`
- **AND** `release ensure-tag X.Y.Z <peeled-merge-oid> --packed-candidate C` runs
- **AND** the factory control checkout HEAD is pin `P` that is not `C`
- **THEN** the helper SHALL NOT throw `HMAC candidate_git_sha is not this ship's packed candidate`
- **AND** it SHALL create and push annotated tag `vX.Y.Z` on the peeled merge commit when the tag is missing and other tag-path rules hold

#### Scenario: HMAC bound to pin P still fails closed for packed C

- **WHEN** on-disk HMAC `latest.json` has `candidate_git_sha` equal to pin `P`
- **AND** `--packed-candidate` is train candidate `C`
- **AND** `P` is not `C`
- **THEN** `release ensure-tag` SHALL fail closed
- **AND** it SHALL throw `HMAC candidate_git_sha is not this ship's packed candidate` or an equivalent fail-closed error
- **AND** it SHALL NOT create or push `vX.Y.Z`
- **AND** it SHALL NOT skip HMAC
