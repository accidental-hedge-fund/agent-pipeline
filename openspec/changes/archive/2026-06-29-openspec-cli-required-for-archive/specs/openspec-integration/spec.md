## ADDED Requirements

### Requirement: Missing OpenSpec CLI blocks pre-merge archive when active changes exist

The pre-merge archive step SHALL require the `openspec` CLI whenever the branch has active
change candidates to archive. When `openspec archive` reports the CLI is unavailable
(`unavailable: true`) and one or more active change directories exist in the branch diff,
the step SHALL call `setBlocked` with stage `pre-merge` and type `openspec-invalid`, using a
reason that names the missing `openspec` CLI and the affected change id, and SHALL return a
blocked outcome (`{ advanced: false, status: "blocked" }`). The step SHALL NOT return a
non-blocking `null` (skip) in this case, because skipping leaves the active change unarchived
and ships an orphaned `openspec/changes/<id>/` directory to the base branch. When there are
no active candidates, the missing CLI SHALL NOT block — the step SHALL return `null` and
pre-merge SHALL continue unaffected, preserving the behavior of repos with nothing to
archive. This makes the archive step consistent with `doctor` (which already requires the
CLI when OpenSpec is active) and with planning (which blocks with an install hint).

#### Scenario: CLI unavailable with active candidates — blocks

- **WHEN** `maybeArchiveOpenspec` is called and OpenSpec is active for the worktree
- **AND** the branch diff contains one or more active change directories (candidates exist)
- **AND** `openspec archive` for a candidate returns `{ unavailable: true }`
- **THEN** the step SHALL call `setBlocked` with stage `pre-merge` and type `openspec-invalid`
- **AND** the blocking reason SHALL name the missing `openspec` CLI and the affected change id
- **AND** the step SHALL return `{ advanced: false, status: "blocked" }`
- **AND** the step SHALL NOT return `null`
- **AND** the step SHALL NOT push an archive commit

#### Scenario: CLI unavailable with no active candidates — continues unaffected

- **WHEN** `maybeArchiveOpenspec` is called and OpenSpec is active for the worktree
- **AND** the branch diff contains no active change directories (no candidates)
- **THEN** the step SHALL return `null` before invoking the `openspec` CLI
- **AND** SHALL NOT call `setBlocked`
- **AND** pre-merge SHALL continue to the next check unaffected

#### Scenario: CLI available with active candidates — archives as before

- **WHEN** `maybeArchiveOpenspec` is called and OpenSpec is active for the worktree
- **AND** the branch diff contains one or more active change directories (candidates exist)
- **AND** the `openspec` CLI is available
- **THEN** the step SHALL invoke `openspec archive` for each candidate
- **AND** on success SHALL commit and push the archived specs and return a `waiting` outcome
  so CI re-runs (or `null` if the archive produced no diff)
- **AND** on archive failure SHALL block with type `openspec-invalid` as before
