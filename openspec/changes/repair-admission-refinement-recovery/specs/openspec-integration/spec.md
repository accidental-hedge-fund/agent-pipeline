## ADDED Requirements

### Requirement: Accepted OpenSpec refinements SHALL become the authoritative implementation artifact

After plan review requests revision, Pipeline SHALL treat revision acknowledgement and artifact application as separate gates. Acknowledgement success SHALL NOT prove that the OpenSpec change was refined. Before implementation, Pipeline SHALL establish that the accepted refinement is reflected in one coherent authoritative change, structurally validate that change, reread its proposal, tasks, and spec deltas from the issue worktree, and derive the implementation input from those reread artifacts.

A refinement SHALL fail explicitly when it is unchanged, was not applied to the authoritative change, conflicts across its proposal, tasks, or spec deltas, or fails structural validation. Pipeline SHALL NOT substitute the previously accepted proposal or revision stdout for a missing application while reporting refinement success. This requirement SHALL leave the freeform planning path unchanged.

#### Scenario: Applied refinement reaches implementation

- **WHEN** plan review requests a substantive OpenSpec revision
- **AND** the revision worker applies that refinement coherently to the authoritative change
- **AND** the revised change passes structural validation
- **THEN** Pipeline SHALL reread the revised proposal, tasks, and spec deltas from that change
- **AND** the implementation input SHALL contain the accepted refined artifact content rather than the prior proposal

#### Scenario: Acknowledged but unapplied refinement fails

- **WHEN** the revision output acknowledges the review request
- **AND** the authoritative OpenSpec artifacts remain unchanged or do not contain the accepted substantive refinement
- **THEN** Pipeline SHALL reject the revision before implementation
- **AND** it SHALL NOT deliver the prior proposal as though refinement succeeded

#### Scenario: Incoherent or invalid refinement fails

- **WHEN** revision changes one or more OpenSpec artifacts but leaves the authoritative change incoherent or structurally invalid
- **THEN** Pipeline SHALL surface an explicit OpenSpec refinement failure with bounded validation evidence
- **AND** implementation SHALL NOT start from either the invalid change or the prior accepted plan

#### Scenario: Freeform revision behavior is unchanged

- **WHEN** planning runs in a repository without the active OpenSpec flow
- **THEN** revision acknowledgement and implementation input SHALL continue to use the existing freeform contract
- **AND** no OpenSpec artifact-application gate SHALL be required
