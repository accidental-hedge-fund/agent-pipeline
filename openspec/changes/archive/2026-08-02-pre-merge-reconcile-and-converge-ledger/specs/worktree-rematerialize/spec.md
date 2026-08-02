## ADDED Requirements

### Requirement: Rematerialize and poisoned-tree handling SHALL be reconcile actions bound to the attempt ledger

Missing, stale, and poisoned/mismatched managed worktree handling SHALL be expressed as actions
from the worktree reconcile-and-converge surface. Rematerialize attempts that consume bounded
recovery budget SHALL claim through the stage-attempt ledger when they are recovery one-shots.
Successful rematerialize SHALL still verify HEAD/candidate currency before stages proceed. Durable
`gate_result` evidence for rematerialize remains required when a run directory is present.

#### Scenario: Missing tree rematerialize is a reconcile action

- **WHEN** a stage requires a managed worktree and none is present
- **THEN** worktree reconcile SHALL return rematerialize/recreate
- **AND** the stage SHALL attempt rematerialize before parking for absence when policy permits

#### Scenario: Poisoned tree refuses proceed-on-wrong-revision

- **WHEN** a managed worktree exists but HEAD or branch identity does not match the expected
  candidate (poisoned/mismatched)
- **THEN** reconcile SHALL not return retain-as-healthy
- **AND** stages SHALL rematerialize/repair or fail typed rather than continue on the wrong revision
  (#769 class)

#### Scenario: Bounded rematerialize attempts use the ledger when charged

- **WHEN** rematerialize is a budgeted recovery action for the current candidate
- **THEN** the attempt SHALL be claimed on the stage-attempt ledger before side effects that consume
  that budget
- **AND** restart SHALL not grant an uncharged second rematerialize for the same key
