## ADDED Requirements

### Requirement: Archive commit failure blocks pre-merge and prevents push

After `openspec archive` succeeds and `git add -A` stages a non-empty diff, the pre-merge stage SHALL check whether `git commit` exits zero. If the commit exits non-zero, the stage SHALL call `setBlocked` with the commit stderr as the blocking reason and SHALL return `{ status: "blocked" }` without invoking `git push`. The push MUST NOT be attempted when the archive commit fails.

#### Scenario: commit fails after archive produces diff

- **WHEN** `maybeArchiveOpenspec` is called
- **AND** `openspec archive` succeeds for all active candidates
- **AND** `git status --porcelain` reports a non-empty diff (staged files)
- **AND** `git commit` exits non-zero (e.g., rejected by a pre-commit hook or git config error)
- **THEN** the stage SHALL set a pre-merge blocker on the issue with the commit stderr included in the reason
- **AND** SHALL return `{ advanced: false, status: "blocked", reason: "archive commit failed" }` (or equivalent)
- **AND** SHALL NOT invoke `git push origin <branch>`

#### Scenario: worktree has dirty state outside openspec/ before archive

- **WHEN** `maybeArchiveOpenspec` is called
- **AND** `git status --porcelain` (run before `openspec archive`) reports dirty files outside `openspec/` paths
- **THEN** the stage SHALL set a pre-merge blocker on the issue
- **AND** SHALL return `{ advanced: false, status: "blocked" }` without invoking `openspec archive`

#### Scenario: commit succeeds — push proceeds normally

- **WHEN** `maybeArchiveOpenspec` is called
- **AND** `openspec archive` succeeds and a non-empty diff is staged
- **AND** `git commit` exits zero
- **THEN** the stage SHALL proceed to `git push origin <branch>` as before
- **AND** the existing push-failure and waiting paths SHALL remain unchanged
