## ADDED Requirements

### Requirement: The supervisor SHALL treat host-local lock and already-running dispatch failures as non-fatal coexistence

When per-item execution returns a `failed` (or unrecognized) outcome whose evidence indicates a host-local lock collision, already-running advance, or install-in-progress mutual exclusion for that item, the supervisor SHALL apply a non-fatal coexistence disposition — attach, wait, skip, or equivalent non-terminal progress — rather than recording the item as `blocked` under `workflow-engine-defect` and rather than recording a `run_fatal` stop for the run. This path SHALL compose with existing Pass-2 safety nets (precondition no-op exclusion and needs-human `pipeline:blocked` hold) and SHALL run as an explicit branch before the default genuine-defect classification. An outcome outside the defined terminal set that carries no coexistence evidence and no needs-human blocked disposition SHALL still be recorded as `failed` and classified under existing `workflow-engine-defect` / `run_fatal` policy.

#### Scenario: Lock collision does not run_fatal a multi-item run

- **WHEN** the supervisor dispatches item `675` and the execution seam reports failure with already-running or lock-held evidence
- **THEN** the supervisor SHALL NOT record `stop.reason = run_fatal` for that outcome
- **AND** it SHALL NOT set the item's blocked theme to `workflow-engine-defect`
- **AND** sibling items that are still schedulable or already `ready` SHALL remain eligible for continuation or disclosure under existing rules

#### Scenario: Unrecognized outcome without coexistence evidence stays failed

- **WHEN** per-item execution reports an outcome outside the defined terminal set
- **AND** no lock-held, already-running, install-in-progress, precondition no-op, or `pipeline:blocked` needs-human evidence applies
- **THEN** the supervisor SHALL record the item as `failed` under existing policy
- **AND** `workflow-engine-defect` / `run_fatal` SHALL apply unchanged

#### Scenario: Coexistence wait does not disable the no-progress watchdog

- **WHEN** the supervisor repeatedly applies a coexistence wait for the same item across cycles
- **AND** no durable progress is recorded (no new coexistence evidence, no terminal advance, no other item transitions)
- **THEN** the existing consecutive no-progress / supervisor watchdog bounds SHALL still be able to stop the run
- **AND** a cycle that newly records durable coexistence evidence or advance progress SHALL count as progress under existing progress classification
