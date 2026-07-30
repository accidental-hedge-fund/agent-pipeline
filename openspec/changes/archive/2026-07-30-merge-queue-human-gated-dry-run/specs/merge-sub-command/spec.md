## ADDED Requirements

### Requirement: Per-PR `merge` remains the sole merge primitive while merge-queue is dry-run only
The existing human-invoked `pipeline merge <pr>` sub-command SHALL remain the
only code path that performs a squash merge for a ready-to-deploy PR in this
change. The merge-queue dry-run surface SHALL NOT call `mergePr` or otherwise
bypass the merge sub-command’s mergeability, required-check, and R2D gates.
A future sequential-drive change MAY invoke the merge primitive once per ordered
candidate under explicit operator drive, without relaxing those gates.

#### Scenario: Dry-run merge-queue does not squash-merge
- **WHEN** `pipeline merge-queue --milestone <m>` runs in dry-run mode against
  one or more merge candidates
- **THEN** `gh pr merge` / `mergePr` SHALL NOT be invoked for any candidate

#### Scenario: Operator still merges a single PR via merge
- **WHEN** the operator runs `pipeline merge 42` on a PR that passes merge gates
- **THEN** the existing merge sub-command behavior SHALL apply unchanged by this
  change’s dry-run queue surface
