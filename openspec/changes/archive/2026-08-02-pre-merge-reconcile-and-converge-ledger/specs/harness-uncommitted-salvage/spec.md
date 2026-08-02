## ADDED Requirements

### Requirement: The engine SHALL NOT write worktree-local attempt-marker files as recovery authority

The engine SHALL NOT write `.pipeline-rebase-attempted` (or any new worktree-local attempt-marker
file) as durable recovery attempt authority. Rebase and related one-shots SHALL use the stage-
attempt ledger. Salvage SHALL continue to exclude residual legacy marker paths from dirtiness and
staging as defense-in-depth so a leftover marker cannot become a salvage-only commit.

#### Scenario: New rebase recovery does not create the marker file

- **WHEN** pre-merge or conflict recovery records a rebase attempt
- **THEN** durable authority SHALL be the stage-attempt ledger
- **AND** the engine SHALL NOT create `.pipeline-rebase-attempted` solely to record that attempt

#### Scenario: Residual legacy marker still does not salvage

- **WHEN** a worktree still contains a leftover `.pipeline-rebase-attempted` from an older run
- **AND** that path is the only dirty path
- **THEN** salvage SHALL still treat the worktree as clean for salvage purposes
- **AND** SHALL NOT produce a marker-only commit
