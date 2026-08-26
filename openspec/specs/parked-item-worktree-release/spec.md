# parked-item-worktree-release Specification

## Purpose
TBD - created by archiving change release-blocked-worktrees-on-hold. Update Purpose after archive.

## Requirements

### Requirement: Durable park SHALL release a safe managed worktree

When an issue reaches a durable non-transient park or hold — an advance outcome that leaves the issue waiting without further harness execution in its managed worktree (including needs-human holds and non-immediately-recoverable blocked outcomes) — the pipeline SHALL attempt to release that issue's managed worktree. Release SHALL succeed only when every safety precondition holds: the worktree path is under a managed root, the working tree is clean, local-only commit verification reports no unpushed commits, and the branch tip is present on the remote **or** an open PR with a resolvable head SHA exists for that head branch (so resume can reconstruct from that commit). On successful release the worktree directory SHALL be deregistered and removed from disk so it no longer appears in the on-disk listing used by capacity counting; the remote branch and any open PR SHALL NOT be deleted by release. Release logic SHALL reuse the same dirty and local-only safety ladder as operator remove / create reclaim (no automatic force discard).

#### Scenario: Clean parked worktree with remote branch is released

- **WHEN** issue N durable-parks and its managed worktree is clean, has no local-only commits, and branch tip exists on the remote
- **THEN** the pipeline SHALL remove that managed worktree from disk and deregister it
- **AND** the remote branch SHALL remain
- **AND** a subsequent capacity count SHALL NOT include a worktree for issue N

#### Scenario: Clean parked worktree with open PR is released

- **WHEN** issue N durable-parks and its managed worktree is clean with no local-only commits
- **AND** an open PR with a resolvable head SHA exists for the pipeline head branch even if remote-tip verification is otherwise marginal
- **THEN** the pipeline SHALL release the managed worktree without deleting the PR or remote branch

#### Scenario: Out-of-managed-root worktree is never auto-released

- **WHEN** issue N has a worktree record with `underManagedRoot === false`
- **AND** issue N durable-parks
- **THEN** the pipeline SHALL NOT remove that worktree via park-release

### Requirement: Unsafe park SHALL retain the worktree with a visible reason

When durable park would release a worktree but any safety precondition fails — dirty working tree, definitive local-only commits, unverifiable or failed local-only verification, or neither remote branch tip nor open PR with resolvable head — the pipeline SHALL retain the worktree on disk, SHALL NOT force-delete it, and SHALL surface a retain reason to the operator (run log and/or blocker/hold text) so capacity occupancy is explainable.

#### Scenario: Dirty worktree is retained on park

- **WHEN** issue N durable-parks and `git status --porcelain` in its managed worktree is non-empty
- **THEN** the worktree SHALL remain on disk
- **AND** the operator-visible retain reason SHALL name the dirty condition

#### Scenario: Local-only commits retain the worktree

- **WHEN** issue N durable-parks and local-only commit verification reports definitive unpushed commits
- **THEN** the worktree SHALL remain on disk
- **AND** the retain reason SHALL name the local-only condition

#### Scenario: Missing remote recoverability retains the worktree

- **WHEN** issue N durable-parks and the branch tip is not on the remote and no open PR with resolvable head exists for that head
- **THEN** the worktree SHALL remain on disk
- **AND** the retain reason SHALL name missing remote/PR recoverability

### Requirement: Resume after release SHALL recreate via the normal create path

When an issue whose managed worktree was park-released is advanced again (unblock, re-run, or durable resume) **and the current stage requires a managed worktree** (planning / implementing bootstrap, or any earlier stage that executes in the worktree), the pipeline SHALL obtain a worktree through the existing `createWorktree` / planning bootstrap path. Same-issue reclaim and the rule that the current issue does not count against `max_concurrent_worktrees` for its own create SHALL remain in force. Park-release SHALL NOT invent a separate branch or worktree naming scheme. When the remote branch tip is absent but an open PR head SHA is available, `createWorktree` SHALL start from that PR head (fetching it) rather than from `origin/<base_branch>` alone.

When the current stage is at or after `pre-merge` and the run does not need a managed worktree for harness work, the pipeline SHALL NOT rematerialize a worktree solely so trusted-surface or ready-to-deploy can resolve a candidate SHA. Candidate SHA resolution on that path SHALL follow `trusted-surface-rebind` (linked open PR head matching the last-advanced candidate, or an explicit candidate-SHA override). Park-release safety and retain rules SHALL stay unchanged.

#### Scenario: Re-advance after release creates a new worktree

- **WHEN** issue N was park-released (no managed worktree on disk)
- **AND** the pipeline advances issue N again at a stage that requires a managed worktree
- **THEN** `createWorktree` (or equivalent bootstrap) SHALL create a managed worktree for issue N
- **AND** same-issue capacity exclusion SHALL still apply so issue N does not block itself

#### Scenario: Resume after PR-only release reconstructs at PR head

- **WHEN** issue N was park-released because an open PR with resolvable head SHA existed and the remote branch tip was absent
- **AND** the pipeline advances issue N again at a stage that requires a managed worktree
- **THEN** `createWorktree` SHALL use the open PR head (not only `origin/<base_branch>`) as the worktree start point

#### Scenario: Late-stage re-entry does not rematerialize solely for trusted-surface

- **WHEN** issue N was park-released (no managed worktree on disk)
- **AND** the pipeline re-enters issue N at or after `pre-merge`
- **AND** a linked open PR head matches the last-advanced candidate (or an explicit candidate-SHA override is present)
- **THEN** the pipeline SHALL NOT create a managed worktree solely to satisfy trusted-surface or ready-to-deploy candidate SHA resolution
- **AND** trusted-surface SHALL still resolve `candidate_sha` from that PR head or override

#### Scenario: Idempotent release when already absent

- **WHEN** durable park runs for issue N and no managed worktree is on disk
- **THEN** park-release SHALL be a no-op success
- **AND** SHALL NOT fail the park outcome solely because the worktree is already absent

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
