## ADDED Requirements

### Requirement: Archive step is idempotent across polling iterations

The pre-merge archive step SHALL detect whether a pipeline-internal archive commit already exists on the PR branch for this issue before invoking `openspec archive`. If such a commit is found, the archive step SHALL be skipped and the gate SHALL proceed to the next check without pushing a new commit or returning `waiting`. The detection SHALL read the branch's commit history (commits between `origin/<base_branch>` and `HEAD`), not the local filesystem state.

#### Scenario: archive already committed — step skipped

- **WHEN** `maybeArchiveOpenspec` is called
- **AND** the branch commit history contains a commit whose headline starts with `"chore: archive OpenSpec change(s) for #<issueNumber>"`
- **THEN** the gate SHALL skip `openspec archive` entirely
- **AND** SHALL NOT push a new archive commit
- **AND** SHALL return `null` (continue to the next pre-merge check)

#### Scenario: no prior archive commit — archive proceeds normally

- **WHEN** `maybeArchiveOpenspec` is called
- **AND** no archive commit for this issue exists in the branch commit history
- **AND** active change directories are found in the diff
- **THEN** the gate SHALL invoke `openspec archive` for each active change as before
