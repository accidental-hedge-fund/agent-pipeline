## ADDED Requirements

### Requirement: Dead-holder interrupt SHALL resume before restart_workflow_engine

When fresh evidence is a resume-eligible interrupt (dead holder, leftover mid-stage labels, no live process identity), the controller SHALL claim a deterministic resume of the same item as the first recipe. That resume SHALL use the existing implementing-resume / stranded-stage recovery path (worktree + labels + ledger). The controller SHALL NOT claim `restart_workflow_engine` as the first recipe for that evidence. The controller SHALL NOT consume the `workflow-engine-defect` class budget for that interrupt. `unlink_engine_scratch` MAY still run when porcelain is scratch-only; a no-op unlink SHALL NOT escalate the interrupt into `workflow-engine-defect`.

#### Scenario: First recipe after kill is resume

- **WHEN** the controller observes issue N at `pipeline:implementing` with a dead holder
- **THEN** the first claimed recovery action SHALL be resume of issue N
- **AND** it SHALL NOT be `restart_workflow_engine`
- **AND** the `workflow-engine-defect` remaining budget SHALL be unchanged by that interrupt

#### Scenario: No-op scratch unlink does not escalate

- **WHEN** `unlink_engine_scratch` runs after a dead-holder interrupt and unlinks nothing
- **THEN** the controller SHALL continue the resume path for the same item
- **AND** it SHALL NOT treat the no-op as a `workflow-engine-defect` that burns `restart_workflow_engine`

#### Scenario: Budget burn to zero fails the fixture

- **WHEN** a fixture replays the 2026-08-16 kill-then-re-ship sequence (dead lock, no-op unlink, reused loop id)
- **THEN** the fixture SHALL fail if `restart_workflow_engine` is claimed
- **AND** the fixture SHALL fail if the `workflow-engine-defect` class budget reaches zero
