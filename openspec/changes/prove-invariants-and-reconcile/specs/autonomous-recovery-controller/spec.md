## ADDED Requirements

### Requirement: The controller SHALL reconcile after every recovery action and SHALL keep SHA and rebase drift owned

After every recovery action, the controller SHALL reconcile run ownership, candidate identity, worktree state, and PR identity against the declared observers before the next adapter attempt or human hold. Claimed candidate SHA unequal to on-disk HEAD, including a worktree mid-rebase with staged product dirt, SHALL be local/remote drift. `repair_pipeline_item` SHALL NOT refuse as human STOP solely for that drift. Unfinished rebase SHALL NOT be treated as a completed archive candidate. The OpenSpec dirty-before-archive fail-closed SHALL remain when product dirt is present. Recovery recipes MAY abort an unfinished rebase or rematerialize after that observation. Those recipes SHALL NOT run inside the observer.

#### Scenario: Post-recovery reconcile runs before the next attempt

- **WHEN** a recovery recipe rematerializes a worktree or aborts an unfinished rebase
- **THEN** the controller SHALL observe candidate SHA, worktree porcelain, and PR identity before the next adapter attempt
- **AND** SHALL NOT treat the recipe as verified completion of the original mutation

#### Scenario: Claimed SHA versus on-disk HEAD is not human STOP

- **WHEN** a repair claim names SHA A
- **AND** the worktree HEAD is SHA B with unfinished rebase and staged product dirt
- **THEN** the controller SHALL record local/remote drift
- **AND** SHALL NOT refuse as `needs-human` solely for that mismatch
- **AND** SHALL NOT skip dirty-before-archive fail-closed

#### Scenario: Unfinished rebase is observed before archive retry

- **WHEN** recovery sees an unfinished rebase after a completed archive side effect
- **THEN** the controller SHALL observe the rebase as in-progress
- **AND** SHALL NOT replay the archive
- **AND** SHALL keep the Logical Operation owned
