## ADDED Requirements

### Requirement: A detached launcher SHALL reattach an eligible durable run after worker or machine restart

A detached launcher SHALL discover and reattach an existing non-terminal run through the Liveness Provider after the wrapper, worker, or machine restarts. A later launcher on the same host SHALL reattach that run identity under the same fenced lease. It SHALL NOT mint a new Logical Operation for unfinished work that still has a durable resume binding. A second `--detach` for a live holder SHALL keep failing as duplicate exclusion. A second `--detach` for a dead holder of a non-terminal run SHALL restore rather than start an unrelated new run. Wrapper `sentinel.json` with a non-zero exit SHALL be execution-attempt evidence. It SHALL NOT be verified completion.

#### Scenario: Dead wrapper of a non-terminal run is restored

- **WHEN** `pipeline run <N> --detach` started a run that is still non-terminal
- **AND** the wrapper process is dead
- **AND** a later launcher on the same host restores or detaches that issue
- **THEN** the launcher SHALL reattach the existing run identity
- **AND** it SHALL NOT create a second Logical Operation

#### Scenario: Live holder still rejects a duplicate detach

- **WHEN** a detached wrapper still holds the issue-run lock with a live matching process identity
- **AND** a second `pipeline run <N> --detach` is invoked for the same domain
- **THEN** the second invocation SHALL exit non-zero without starting a duplicate supervisor

#### Scenario: Non-zero sentinel is not logical completion

- **WHEN** a detached wrapper writes `sentinel.json` with a non-zero exit and the Logical Operation is unproven
- **THEN** restore SHALL treat that sentinel as worker-exit evidence
- **AND** it SHALL NOT treat the Logical Operation as verified complete
