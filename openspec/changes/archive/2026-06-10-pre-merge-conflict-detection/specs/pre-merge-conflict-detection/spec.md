## ADDED Requirements

### Requirement: Pre-merge gate checks mergeability before waiting for CI

The pre-merge gate SHALL fetch PR mergeability state before beginning the CI-check poll. If the mergeability state is CONFLICTING or DIRTY, the gate SHALL immediately route to the rebase path without polling for CI check runs.

#### Scenario: CONFLICTING PR is detected before CI poll begins

- **WHEN** the pre-merge gate begins processing a PR
- **AND** `gh pr view --json mergeable,mergeStateStatus` returns `mergeable: "CONFLICTING"` or `mergeStateStatus: "DIRTY"`
- **THEN** the gate SHALL skip the CI-check poll entirely
- **AND** SHALL invoke `tryRebaseAndPush` for the PR branch
- **AND** SHALL NOT return a "CI still running" or "gh pr checks failed" waiting reason

#### Scenario: Non-conflicting PR with no CI workflow is unaffected

- **WHEN** the pre-merge gate begins processing a PR
- **AND** the PR is not CONFLICTING (mergeable is MERGEABLE or UNKNOWN)
- **AND** `getPrChecks` returns zero check runs (repo has no CI workflow)
- **THEN** the gate SHALL treat zero checks as passing
- **AND** SHALL proceed to the mergeability check as today

#### Scenario: UNKNOWN mergeability does not trigger the early-conflict path

- **WHEN** the pre-merge gate fetches PR detail
- **AND** GitHub has not yet computed mergeability (`mergeable` is null / UNKNOWN)
- **THEN** the gate SHALL NOT invoke the early-conflict rebase path
- **AND** SHALL continue with the CI poll as normal

---

### Requirement: Early-conflict rebase attempt is bounded by a rebase-attempted guard

The pre-merge gate SHALL apply the same `rebaseAlreadyAttempted` marker check to the early-conflict rebase path as it does to the CI-failure rebase path, so that a PR whose conflict cannot be automatically resolved does not loop indefinitely attempting a rebase on each poll iteration.

#### Scenario: First conflict detection attempts rebase

- **WHEN** the pre-merge gate detects CONFLICTING mergeability on the first poll iteration
- **AND** no rebase has been attempted yet for this worktree
- **THEN** the gate SHALL invoke `tryRebaseAndPush`
- **AND** if the rebase succeeds SHALL mark the rebase as attempted
- **AND** SHALL return `status: "waiting"` with reason "rebase-resolved; CI re-running"

#### Scenario: Rebase already attempted — blocks instead of looping

- **WHEN** the pre-merge gate detects CONFLICTING mergeability
- **AND** a rebase has already been attempted for this worktree (marker present)
- **THEN** the gate SHALL NOT invoke `tryRebaseAndPush` again
- **AND** SHALL call `setBlocked` with a clear "merge conflict — manual rebase needed" reason
- **AND** SHALL return `status: "blocked"`

---

### Requirement: Auto-rebase failure emits a clear conflict-specific block reason

When the early-conflict rebase path is invoked but `tryRebaseAndPush` returns false (rebase could not be resolved automatically), the pre-merge gate SHALL block the item with a reason that explicitly names the merge conflict as the cause, not a generic CI or timeout message.

#### Scenario: Auto-rebase fails — block reason names merge conflict

- **WHEN** the pre-merge gate invokes `tryRebaseAndPush` via the early-conflict path
- **AND** `tryRebaseAndPush` returns false (conflict cannot be auto-resolved)
- **THEN** the gate SHALL call `setBlocked` with a reason containing the text "merge conflict" and "manual rebase needed"
- **AND** SHALL return `status: "blocked"` with `reason: "merge conflict"`
- **AND** SHALL NOT return `status: "waiting"` or a CI-related block reason
