## ADDED Requirements

### Requirement: Every candidate-engine operation SHALL cross the shared resolve-and-prepare gate

Every production route that executes candidate-engine code SHALL obtain its launcher and canonical root from the shared resolve-and-prepare gate. Before returning, that gate SHALL prove the requested exact candidate SHA, approved root, candidate readiness, and tracked cleanliness both before and after any bootstrap. An identity-only resolver, prior readiness for another SHA or lockfile digest, path-local bootstrap, or inherited process launcher SHALL NOT authorize candidate-engine execution. The executable operation inventory SHALL cover every candidate-engine consumer and the repository hard gate SHALL fail when a consumer bypasses resolve-and-prepare.

#### Scenario: Inventory consumer cannot spawn before preparation

- **WHEN** an inventoried ship, Factory Reliability Gate, release, recovery, or host-adapter route requests candidate-engine execution
- **AND** resolve-and-prepare has not returned a proof for the exact requested candidate
- **THEN** no candidate-engine process SHALL spawn
- **AND** the route SHALL fail closed with typed diagnostics

#### Scenario: Candidate movement invalidates prepared identity

- **WHEN** a root was prepared at candidate SHA `C1`
- **AND** its HEAD moves to `C2` before the candidate command starts
- **THEN** the candidate command SHALL NOT spawn on the prior proof
- **AND** resolve-and-prepare SHALL require exact identity, readiness, and cleanliness proof for `C2`

#### Scenario: New candidate consumer without the gate fails validation

- **WHEN** a production route capable of spawning candidate-engine code is added without an exercised resolve-and-prepare binding
- **THEN** the repository hard validation gate SHALL fail
- **AND** the failure SHALL identify that consumer
