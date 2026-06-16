## ADDED Requirements

### Requirement: Archive step is idempotent across polling iterations

The pre-merge archive step SHALL compute the current active OpenSpec candidates from the branch diff before consulting commit history. If no active change directories remain in the diff, the archive step SHALL be skipped and the gate SHALL proceed to the next check without pushing a new commit or returning `waiting`. If active candidates exist, the gate SHALL invoke `openspec archive` regardless of whether a prior archive commit is found in the branch history.

#### Scenario: no active candidates — step skipped

- **WHEN** `maybeArchiveOpenspec` is called
- **AND** the branch diff contains no active change directories (either already archived and removed, or none ever existed)
- **THEN** the gate SHALL skip `openspec archive` entirely
- **AND** SHALL NOT push a new archive commit
- **AND** SHALL return `null` (continue to the next pre-merge check)

#### Scenario: prior archive commit exists but active candidates remain — re-archive

- **WHEN** `maybeArchiveOpenspec` is called
- **AND** the branch diff contains one or more active change directories
- **AND** a prior archive commit for this issue exists in the branch history (e.g., a revert re-introduced a change)
- **THEN** the gate SHALL invoke `openspec archive` for each active candidate
- **AND** SHALL NOT skip based on the prior archive commit alone

#### Scenario: no prior archive commit — archive proceeds normally

- **WHEN** `maybeArchiveOpenspec` is called
- **AND** no archive commit for this issue exists in the branch commit history
- **AND** active change directories are found in the diff
- **THEN** the gate SHALL invoke `openspec archive` for each active change as before
