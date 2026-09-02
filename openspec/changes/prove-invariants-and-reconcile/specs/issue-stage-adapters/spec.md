## MODIFIED Requirements

### Requirement: Every delivery-stage adapter SHALL declare its operation invariants

Each delivery-stage adapter SHALL declare the relevant operation invariant for its attempt:
precondition, postcondition, authoritative observer, candidate binding, side-effect identity, safe
replay predicate, and reconstruction rule. A process exit, exception, timeout, or model response
SHALL be ingress evidence, not success by itself. Verified completion SHALL require the declared
observer to prove the postcondition for the bound candidate and side-effect identity. The adapter
SHALL observe that invariant before any local transport retry.

#### Scenario: Missing invariant fails the contract

- **WHEN** a delivery stage from `planning` through `ready-to-deploy` has no declared operation invariant
- **THEN** a contract test SHALL fail and name that stage

#### Scenario: Missing reconstruction rule fails the contract

- **WHEN** a delivery stage from `planning` through `ready-to-deploy` omits side-effect identity, safe replay predicate, or reconstruction rule
- **THEN** a contract test SHALL fail and name that stage

#### Scenario: Exit zero is not verified completion

- **WHEN** a stage adapter process exits 0
- **AND** the authoritative observer has not proven the postcondition for the bound candidate
- **THEN** the observation SHALL NOT mark the Logical Operation complete
- **AND** side-effect certainty SHALL NOT be `known_complete` solely because of the exit code

#### Scenario: Adapter observes before local retry

- **WHEN** a delivery-stage adapter is about to retry a proven-idempotent transport operation
- **THEN** it SHALL observe the declared invariant first
- **AND** SHALL NOT retry when side-effect certainty is `known_complete` or `uncertain`

#### Scenario: Observed completion is verified success of the original operation

- **WHEN** a local attempt fails or times out
- **AND** the observer then proves side-effect certainty `known_complete`
- **THEN** the retry result SHALL complete as verified success on the original Logical Operation
- **AND** SHALL NOT return the failed attempt as the final result
- **AND** SHALL NOT replay the mutation

#### Scenario: Uncertain observation stays owned cooling

- **WHEN** a local attempt fails or times out
- **AND** the observer reports side-effect certainty `uncertain`
- **THEN** the retry result SHALL be an owned cooling or external-condition wait outcome
- **AND** SHALL NOT replay
- **AND** SHALL NOT treat the original failed attempt as the final ordinary failure
