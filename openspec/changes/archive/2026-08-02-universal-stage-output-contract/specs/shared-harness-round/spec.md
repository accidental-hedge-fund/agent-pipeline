## ADDED Requirements

### Requirement: Shared harness-round consumers SHALL use the shared format-repair policy for registered stdout contracts

Shared harness-round consumers SHALL apply the shared format-repair policy for pure shape
failures when the consumer produces machine-checkable stdout (or equivalent product output)
governed by a registered stage-output contract, rather than embedding a private full repair
loop. Commit-message and commit-range verifications remain stage-supplied callbacks as today;
this requirement covers registered stage-output contracts only. Non-round stages (for example
plan-revision and OpenSpec authoring) MAY call the same shared repair helper without becoming
shared-round consumers.

#### Scenario: Migrated consumer reuses shared repair for a registered contract

- **WHEN** a shared-round consumer validates a registered stage-output contract and validation
  fails for a pure shape reason with budget remaining
- **THEN** the consumer SHALL invoke the shared format-repair policy
- **AND** SHALL NOT implement a second independent automatic re-prompt budget for that contract

#### Scenario: Non-round stages may use the same helper

- **WHEN** plan-revision or OpenSpec authoring applies format-repair
- **THEN** it SHALL call the same shared format-repair policy module used by shared-round
  consumers
- **AND** SHALL NOT require those stages to become commit-producing shared-round consumers
  solely to obtain repair
