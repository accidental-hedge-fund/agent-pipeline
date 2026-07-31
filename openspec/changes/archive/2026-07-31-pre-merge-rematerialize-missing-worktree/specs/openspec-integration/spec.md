## MODIFIED Requirements

### Requirement: The archive step SHALL fail closed when its preconditions cannot be evaluated

`maybeArchiveOpenspec` SHALL return `null` (continue) only when it has positively established that there is nothing to archive. When the candidate probe `git diff --name-only origin/<base>...HEAD` exits non-zero, the step SHALL call `setBlocked` with stage `pre-merge` and type `openspec-invalid`, using a reason naming the failed git command and its stderr, and SHALL return a blocked outcome — it SHALL NOT treat a failed probe as "no candidates".

When the worktree for the issue cannot be found on disk while the OpenSpec flow is active:

1. The step SHALL determine tip-side active change membership via the PR-head tree listing at the PR’s current head SHA (`listPrHeadChangeDirs` / Contents API at that ref — not cumulative path subtraction alone). Listing failures, auth failures, and ambiguous truncated results SHALL be treated as membership **unconfirmed** (fail-closed), never as an empty active set.
2. When tip membership shows **no** active OpenSpec change directories (positively empty listing), the missing worktree SHALL remain a non-blocking skip (`null`); rematerialize is not required for archive.
3. When tip membership shows **one or more** active OpenSpec change directories, **or** tip membership cannot be confirmed while archive may still be required, the step SHALL **attempt rematerialize** via `ensureManagedWorktree` (see `worktree-rematerialize`) before parking.
4. On rematerialize success, the step SHALL re-resolve the worktree and continue the normal archive path on the recreated worktree.
5. On rematerialize failure, the step SHALL block once with stage `pre-merge` and type `worktree-missing`, `worktree-creation-failed`, or `worktree-capacity` (not bare product `needs-human`), naming the missing worktree and the rematerialize failure, and SHALL NOT return `null` while active change(s) remain unarchived or membership remains unconfirmed.

#### Scenario: candidate probe fails

- **WHEN** `maybeArchiveOpenspec` runs and the `git diff --name-only origin/<base>...HEAD` probe exits non-zero
- **THEN** the step SHALL call `setBlocked` with type `openspec-invalid`
- **AND** the reason SHALL name the git failure
- **AND** the step SHALL return `{ advanced: false, status: "blocked" }` rather than `null`

#### Scenario: worktree missing with active tip change — rematerialize then archive

- **WHEN** the worktree for the issue is not found on disk
- **AND** the OpenSpec flow is active for the repository
- **AND** the PR tip (head SHA tree) still has active OpenSpec change dir(s)
- **AND** rematerialize from the open PR head / verified remote branch succeeds
- **THEN** the step SHALL continue and attempt `openspec archive` for the active change(s) on the recreated worktree
- **AND** SHALL NOT block solely for worktree absence

#### Scenario: worktree missing with active tip change — rematerialize fails typed block

- **WHEN** the worktree for the issue is not found on disk
- **AND** the OpenSpec flow is active for the repository
- **AND** the PR tip still has active OpenSpec change dir(s)
- **AND** rematerialize fails
- **THEN** the step SHALL block with type `worktree-missing` or `worktree-creation-failed` (or `worktree-capacity` when applicable)
- **AND** the reason SHALL name the rematerialize failure
- **AND** the step SHALL NOT return `null` while those active change(s) remain unarchived

#### Scenario: worktree missing and tip membership unconfirmed — rematerialize then typed block on fail

- **WHEN** the worktree for the issue is not found on disk
- **AND** PR-head OpenSpec change listing fails or cannot be confirmed
- **AND** rematerialize fails
- **THEN** the step SHALL block with a typed worktree / rematerialize kind
- **AND** SHALL NOT return `null` while membership remains unconfirmed

#### Scenario: worktree missing with no OpenSpec change on the tip

- **WHEN** the worktree is not found on disk
- **AND** the PR tip listing positively shows no active OpenSpec change dirs
- **THEN** the step SHALL return `null` and pre-merge SHALL continue unchanged

#### Scenario: probe succeeds with no candidates

- **WHEN** the probe exits zero and yields no active change directories
- **THEN** the step SHALL return `null` and pre-merge SHALL continue unchanged
