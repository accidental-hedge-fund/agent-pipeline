## ADDED Requirements

### Requirement: Protected merge execution SHALL require a durable unique-operation admission stamp

The direct merge, merge-queue apply, and train merge-mode adapters SHALL cross their protected merge boundary only after the relevant shared unique-operation admission stamp is durably persisted and verified. Direct `pipeline merge` SHALL use `merge`; `pipeline merge-queue` SHALL use `merge-queue`; and each train-nested merge SHALL use a distinct `merge` record that retains the outer train `logical_operation_id`. The admission record SHALL be observational only and SHALL NOT alter the existing operator envelope, exact-candidate gates, claim protocol, replay rule, or release authority. Admission persistence failure SHALL be a mechanical observation owned by RecoverySupervisor, not a command-local merge retry or a human-authority projection.

#### Scenario: Direct merge stamp precedes submission

- **WHEN** direct `pipeline merge` reaches the point where its exact-candidate merge could be submitted
- **THEN** a qualifying durable `merge` admission artifact SHALL already be verified
- **AND** the merge mutation SHALL NOT be invoked when that verification failed

#### Scenario: Merge-queue stamp precedes apply side effects

- **WHEN** `pipeline merge-queue --apply` is admitted
- **THEN** a qualifying durable `merge-queue` admission artifact SHALL be verified before merge or repair side effects begin
- **AND** the existing per-candidate merge claims and exact-candidate gates SHALL remain required

#### Scenario: Train nested merge has separate physical identity and shared root identity

- **WHEN** `pipeline train --merge` is about to merge PR `P`
- **THEN** a qualifying durable nested `merge` artifact SHALL be verified before submission
- **AND** that record's `logical_operation_id` SHALL equal the outer train admission identity
- **AND** the outer train record SHALL remain a distinct `train` artifact

#### Scenario: Nested stamp failure remains RecoverySupervisor-owned

- **WHEN** train merge mode cannot persist or verify the nested `merge` admission artifact
- **THEN** the merge mutation SHALL NOT be invoked
- **AND** the adapter SHALL report a mechanical operation observation to RecoverySupervisor
- **AND** train SHALL NOT grant itself authority, implement a local recovery controller, or project the failure as human-owned without a genuine typed request

#### Scenario: Stamp does not replace merge proof

- **WHEN** a qualifying merge admission stamp exists
- **THEN** verified completion SHALL still require the existing authoritative PR-state and base-containment proof
- **AND** the stamp SHALL NOT satisfy or widen the operator merge envelope

