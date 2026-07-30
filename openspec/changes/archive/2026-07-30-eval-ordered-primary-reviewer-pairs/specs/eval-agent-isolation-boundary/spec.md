## ADDED Requirements

### Requirement: The eval instruction and command boundary SHALL remain active for every harness invocation in a multi-role cell

The evaluator SHALL keep the eval root instruction contract and the process command-deny
boundary installed for every harness invocation in a multi-role cell. In a cell that
invokes more than one harness role (primary and reviewer, including every stage of
`implementing-paired` and `pipeline-paired`), the boundary SHALL remain active for the
entire sequence of harness invocations. The evaluator SHALL NOT restore repository workflow
instructions between intermediate stages in a way that re-authorizes production skills mid
loop. Restoration of instruction paths and removal of the command-deny shim for clean
changed-path and check collection SHALL occur only after the last harness invocation of the
cell (or on a terminal failure path), and again before teardown as already required.

#### Scenario: Contract is present before every role invocation

- **WHEN** a paired cell runs primary implementation and then reviewer review
- **THEN** the eval root instruction contract SHALL be present in the worktree immediately
  before the primary invocation
- **AND** SHALL still be present immediately before the reviewer invocation

#### Scenario: Boundary is not restored between implement and review

- **WHEN** primary implementation completes successfully and reviewer review is about to run
- **THEN** the evaluator SHALL NOT restore repository root-instruction files for the purpose
  of intermediate evidence collection between those two invocations

#### Scenario: Clean evidence collection restores after the last invocation

- **WHEN** the final harness invocation of a paired cell has completed and checks or changed
  paths are about to be collected
- **THEN** the evaluator SHALL restore root-instruction paths to their base_commit content
  before that collection
- **AND** SHALL exclude evaluator-owned boundary files from treatment changed-path evidence
