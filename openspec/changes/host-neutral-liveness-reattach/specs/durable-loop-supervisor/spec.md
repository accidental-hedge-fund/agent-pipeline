## ADDED Requirements

### Requirement: Supervisor worker death SHALL NOT terminalize a durable loop run

The durable loop supervisor SHALL treat a dead worker, stale heartbeat, or recovered same-host dead-pid lock as lost physical liveness, not as a terminal run stop. After the Liveness Provider claims a fresh fence, the supervisor SHALL resume the same run identity through the existing attach/resume path. RecoverySupervisor SHALL still own recipe selection after the worker is restored. A dead worker SHALL NOT become `run_fatal`, verified completion, ownerless terminal, or human authority solely because the process exited.

#### Scenario: Dead-pid lock recovery keeps the run owned

- **WHEN** a loop run ledger is non-terminal and the lock holder pid is provably dead on this host
- **THEN** restore SHALL recover the lock and reattach the same supervisor
- **AND** the ledger SHALL NOT record a terminal stop solely from that death

#### Scenario: Resume after restore is not manual reinvocation

- **WHEN** the Liveness Provider reattaches a loop supervisor after worker death
- **THEN** the Logical Operation identity SHALL stay the same
- **AND** the resume SHALL NOT count as a new external admission
