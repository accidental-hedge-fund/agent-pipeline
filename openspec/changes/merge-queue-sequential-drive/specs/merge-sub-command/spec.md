## ADDED Requirements

### Requirement: Queue and multi-PR surfaces SHALL reuse `mergePr` rather than forking merge
Queue and multi-PR surfaces SHALL call the exported `mergePr` handler (with `MergeDeps` or a thin logging wrapper around it) for each squash merge of a ready-to-deploy PR, including merge-queue drive under `merge-queue-drive`. Such surfaces SHALL NOT introduce a parallel `gh pr merge` implementation with different flags, weaker gates, or a divergent delete-branch policy. Single-PR `pipeline merge <pr>` remains the canonical CLI entry for one-off merges; queue drive is an operator convenience that still ends in the same handler.

#### Scenario: Merge-queue drive uses mergePr
- **WHEN** merge-queue drive elects to merge PR `#42`
- **THEN** it SHALL invoke `mergePr(42, deps)` (or the documented thin wrapper around that export)
- **AND** SHALL subject the PR to the same mergeability, checks, and ready-to-deploy gates enforced by `mergePr`

#### Scenario: No unguarded merge fork in queue code
- **WHEN** the merge-queue drive implementation is inspected or unit-tested
- **THEN** successful merges SHALL be attributable to calls into `mergePr` / `MergeDeps.ghPrMerge` via the shared handler path
- **AND** SHALL NOT call a separate production code path that runs `gh pr merge` while bypassing `mergePr` gates
