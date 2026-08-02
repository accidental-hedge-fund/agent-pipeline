## ADDED Requirements

### Requirement: Staging exclusions for attempt markers remain defense-in-depth after writer retirement

Salvage staging SHALL retain the depth-agnostic exclusion pathspec for residual
`.pipeline-rebase-attempted` (and any single-sourced pipeline-internal marker list) after the engine
stops writing that path as attempt authority, so leftover dirt cannot enter salvage commits. New
attempt authority SHALL NOT be introduced as an additional worktree-local marker file requiring a
new exclusion.

#### Scenario: Exclusion retained for residual marker path

- **WHEN** salvage stages uncommitted changes
- **THEN** `git add` args SHALL still include `:(exclude,glob)**/.pipeline-rebase-attempted` while
  that path remains in the canonical pipeline-internal marker list
- **AND** no new worktree-local attempt-marker path SHALL be added as production attempt authority
