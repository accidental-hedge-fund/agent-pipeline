## ADDED Requirements

### Requirement: Parked worktree release SHALL evaluate remove safety once

`releaseWorktreeForParkedIssue` (and equivalent parked-release helpers) SHALL evaluate the shared
remove-safety policy exactly once per release decision via `evaluateRemoveSafety` or a single
wrapper that does. The path SHALL NOT run two independent full-policy evaluations that can disagree
or double-apply mutations. Unsafe results retain the worktree with a visible reason as already
required.

#### Scenario: Single safety evaluation per park release

- **WHEN** parked release runs for an issue with a managed worktree
- **THEN** `evaluateRemoveSafety` (or the shared wrapper's evaluation) SHALL run once for that
  decision
- **AND** the release SHALL not invoke a second independent full-policy preflight that can authorize
  a different outcome

#### Scenario: Unsafe park retains the worktree

- **WHEN** the single safety evaluation returns a blocking dirty or local-only result without force
- **THEN** the worktree SHALL be retained
- **AND** the visible park reason SHALL name the unsafe condition
