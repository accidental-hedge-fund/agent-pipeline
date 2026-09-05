## MODIFIED Requirements

### Requirement: Candidate replacement SHALL invalidate candidate-bound evidence

Candidate movement SHALL start a new Candidate epoch. Implementation proofs, review verdicts, test results, eval results, shipcheck results, decisions, authority requests, authority grants, and completion observations bound to the prior epoch SHALL be invalid for the new candidate. RecoverySupervisor SHALL require every fact needed by the next stage to be re-proved against the new candidate before it may gate advancement. Planning-artifact identity SHALL remain distinct and SHALL NOT be rebound as implementation evidence merely because the candidate moved or a planning PR merged.

#### Scenario: New HEAD invalidates prior review verdict

- **WHEN** candidate HEAD moves from SHA `A` to SHA `B`
- **THEN** implementation proof, tests, and review verdicts bound to `A` SHALL NOT authorize advancement at `B`
- **AND** RecoverySupervisor SHALL require the applicable facts to be re-proved at `B`

#### Scenario: Candidate moves during a delivery-stage attempt

- **WHEN** a delivery-stage adapter binds candidate, epoch, evidence role, and artifact identity before an attempt
- **AND** its post-attempt observation does not exactly match that binding
- **THEN** the adapter SHALL NOT accept the attempt as completion
- **AND** RecoverySupervisor SHALL retain ownership and rerun the stage against the replacement candidate

#### Scenario: Authority hold does not survive candidate replacement

- **WHEN** an authority request or grant was bound to candidate epoch `E1`
- **AND** fresh reconciliation observes epoch `E2`
- **THEN** that request or grant SHALL NOT authorize work at `E2`
- **AND** a remaining `pipeline:blocked` label SHALL NOT preserve the stale authority

#### Scenario: Planning identity is not rebound to implementation

- **WHEN** candidate movement preserves or reintroduces a planning artifact
- **AND** no product implementation postcondition is proved for the new epoch
- **THEN** the implementing adapter SHALL report incomplete evidence
- **AND** SHALL NOT report verified completion from the planning artifact

## ADDED Requirements

### Requirement: Delivery-stage observations SHALL identify the evidence role they prove

An observation that can advance a delivery stage SHALL identify the postcondition and evidence role it proves, including whether the bound artifact is planning or implementation. An observation whose role conflicts with the current stage's declared postcondition SHALL be incomplete or uncertain and SHALL remain RecoverySupervisor-owned. The adapter SHALL NOT infer the evidence role from process exit, generic commit presence, labels, comments, or PR merge state alone.

#### Scenario: Implementing adapter receives planning-role evidence

- **WHEN** the implementing adapter observes a current planning artifact but no implementation-role proof
- **THEN** it SHALL report the implementing postcondition as unproved
- **AND** RecoverySupervisor SHALL select continued owned treatment rather than completion

#### Scenario: Mechanical evidence gap does not create a human owner

- **WHEN** an adapter cannot prove the required evidence role because of missing or conflicting mechanical state
- **THEN** the Logical Operation SHALL remain active, cooling, waiting, or under reconstruction
- **AND** SHALL NOT become human-owned without an independently valid typed request
