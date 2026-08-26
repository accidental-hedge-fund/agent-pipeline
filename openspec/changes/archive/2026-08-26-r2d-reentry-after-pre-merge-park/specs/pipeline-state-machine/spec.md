## ADDED Requirements

### Requirement: Ready-to-deploy finalize SHALL tag the linked PR when candidate SHA resolved without a worktree

When an issue reaches `ready-to-deploy` after a re-entry at or after `pre-merge` whose managed worktree is absent, and trusted-surface resolved `candidate_sha` from a matching linked open PR head or an explicit candidate-SHA override, the run SHALL still finalize the happy path: tag the linked PR `pipeline:ready-to-deploy` and post the existing final summary. Absence of a managed worktree SHALL NOT skip that PR tag. The advance loop SHALL still stop at `ready-to-deploy` and SHALL NOT merge.

If trusted-surface remains `blocked` because no matching SHA source exists, finalize SHALL refuse the PR tag and SHALL NOT invent ready-to-deploy on the PR.

Immediately before tagging, finalize SHALL re-fetch the linked open PR and require its head SHA to equal the non-blocked trusted-surface `candidate_sha` persisted for this run. This re-fetch SHALL run before posting the terminal `## Pipeline Complete` summary or applying the ready-to-deploy tag. If the live head differs, is missing, or is not a full 40-character hex SHA, finalize SHALL refuse with a named `stale_pr_head` outcome, SHALL NOT tag the PR, and SHALL NOT post the terminal summary.

#### Scenario: matching PR head after pre-merge park is tagged

- **WHEN** issue N re-enters at `pre-merge` with no managed worktree on disk
- **AND** trusted-surface resolves `candidate_sha` from the linked open PR head that matches the last-advanced candidate
- **AND** remaining gates pass so the issue reaches `ready-to-deploy`
- **THEN** the run SHALL tag that PR `pipeline:ready-to-deploy`
- **AND** the operator-visible log SHALL include `PR #<n> tagged pipeline:ready-to-deploy`
- **AND** the advance loop SHALL NOT merge the PR

#### Scenario: blocked SHA resolution does not tag the PR

- **WHEN** issue N reaches the ready-to-deploy handler
- **AND** trusted-surface outcome is `blocked` because no worktree, no matching open PR head, and no valid override exist
- **THEN** the run SHALL NOT tag the PR `pipeline:ready-to-deploy`
- **AND** the PR SHALL NOT be merged by the advance loop

#### Scenario: stale PR head at finalize is not tagged

- **WHEN** trusted-surface resolved `candidate_sha` to H
- **AND** immediately before ready-to-deploy tagging, the linked open PR head is not H
- **THEN** the run SHALL NOT tag the PR `pipeline:ready-to-deploy`
- **AND** finalize SHALL refuse with a named `stale_pr_head` outcome
- **AND** finalize SHALL NOT post the `## Pipeline Complete` terminal summary
- **AND** the PR SHALL NOT be merged by the advance loop
