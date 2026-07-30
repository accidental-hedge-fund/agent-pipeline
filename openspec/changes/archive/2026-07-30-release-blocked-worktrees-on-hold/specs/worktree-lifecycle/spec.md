## ADDED Requirements

### Requirement: Capacity gate remains issue-scoped and same-issue reclaim safe after park-release

`createWorktree` SHALL continue to refuse when the count of *other* active managed worktrees (open GitHub issues that are not `pipeline:ready-to-deploy`, per `listActive`) is at `cfg.max_concurrent_worktrees`. The current issue number SHALL NOT count against itself. Same-issue managed reclaim SHALL still run before the capacity check so a retry or resume cannot be blocked by the issue's own prior worktree records. Park-released issues with no on-disk managed worktree SHALL not contribute to that count (they are absent from `listOnDisk` / `listActive`). Capacity refusal SHALL throw or return a machine-distinguishable capacity error (stable message prefix or typed identity) so admission disposition can treat pure capacity separately from other create failures.

#### Scenario: Park-released siblings do not fill capacity

- **WHEN** `max_concurrent_worktrees` is 2
- **AND** two other issues previously held managed worktrees but those worktrees were park-released and are absent from disk
- **AND** `createWorktree` runs for a third issue
- **THEN** capacity counting SHALL treat otherActive as 0 from those released issues
- **AND** create SHALL NOT fail solely for capacity on account of the released issues

#### Scenario: Same-issue retry at cap 1 still reclaims self

- **WHEN** `max_concurrent_worktrees` is 1
- **AND** issue N already has a clean managed worktree with no local-only commits
- **AND** `createWorktree` runs again for issue N
- **THEN** same-issue reclaim MAY remove issue N's prior worktree
- **AND** capacity SHALL NOT refuse solely because issue N's own pre-reclaim record was the only active slot

#### Scenario: True other-active capacity still refuses create

- **WHEN** other open non-ready-to-deploy issues each still have on-disk managed worktrees totaling `max_concurrent_worktrees`
- **AND** `createWorktree` runs for a different issue
- **THEN** create SHALL refuse with a capacity error rather than creating another worktree

#### Scenario: Capacity error is distinguishable from generic create failure

- **WHEN** create refuses for capacity
- **THEN** the error or result SHALL be machine-distinguishable as capacity (stable identity)
- **AND** SHALL remain distinct from dirty-reclaim refusal and git worktree-add failures
