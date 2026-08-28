## ADDED Requirements

### Requirement: Ownership-checkpoint commits SHALL count as salvage for downstream verification

A commit authored by ownership checkpoint (`checkpoint_owned_harness_dirt` or the same-process timeout checkpoint) SHALL count as salvage-equivalent for the downstream verification and publish path that already applies to a legacy salvage commit. The engine SHALL run format and test gates on that HEAD before push or PR creation. The engine SHALL NOT skip those gates because the originating harness timed out.

#### Scenario: Checkpoint commit takes the salvage verification path

- **WHEN** ownership checkpoint creates a commit with the salvage subject prefix and issue trailers
- **AND** the implement harness had timed out
- **THEN** the engine SHALL run the same post-commit format and test gates as a legacy salvage commit
- **AND** SHALL NOT block with "No commits found in the range" or with a timeout park solely because legacy salvage did not run

#### Scenario: Checkpoint commit that fails the test gate still blocks at the gate

- **WHEN** the pipeline uses an ownership-checkpoint commit as salvage-equivalent
- **AND** the test gate exits non-zero
- **THEN** the pipeline SHALL block at the test gate with the test failure reason
- **AND** SHALL NOT open a PR or transition to `review-1`
