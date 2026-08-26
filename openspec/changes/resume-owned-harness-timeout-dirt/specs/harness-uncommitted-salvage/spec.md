## ADDED Requirements

### Requirement: Salvage SHALL checkpoint owned leftovers after HEAD movement and across process restart

The salvage/checkpoint path SHALL apply to pipeline-owned harness leftovers even when HEAD advanced during the attempt (intermediate commit) and even when the caller is a new process hydrating durable ownership rather than the original harness invoke. Staging SHALL be scoped to the owned leftover path set from `harness-mutation-ownership`. Unknown product dirt SHALL remain unstaged and SHALL NOT be discarded. Engine-known scratch and `node_modules` exclusions SHALL remain in force. When salvage already ran in-process and porcelain is clean of owned leftovers, a later re-entry SHALL be a no-op checkpoint.

#### Scenario: Intermediate commit plus later dirty files are checkpointed

- **WHEN** the implement harness created a commit (`headAfter !== headBefore`) and then left further product files uncommitted
- **AND** those files are classified as owned leftovers
- **THEN** salvage/checkpoint SHALL create a commit containing those owned files
- **AND** SHALL NOT refuse solely because HEAD already moved

#### Scenario: New process hydrates ownership and checkpoints

- **WHEN** the original process died before salvage
- **AND** a later process loads the durable ownership record and observes owned leftovers
- **THEN** that later process SHALL checkpoint the owned paths
- **AND** SHALL NOT wait for the dead process to salvage

#### Scenario: Unknown dirt is not swept into the salvage commit

- **WHEN** owned leftover path `P` and unknown product path `U` are both dirty
- **THEN** the salvage/checkpoint commit SHALL include `P`
- **AND** SHALL NOT include `U`
- **AND** `U` SHALL remain uncommitted (not discarded)
