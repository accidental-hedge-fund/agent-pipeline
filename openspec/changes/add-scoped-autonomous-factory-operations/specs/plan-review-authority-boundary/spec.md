## MODIFIED Requirements

### Requirement: Operator surfaces SHALL use a closed authority vocabulary for plan-review

Operator-facing product documentation, host skill guidance, CLI help, status prose, and architecture language that describe `plan-review` SHALL use the following closed vocabulary and SHALL NOT treat these terms as synonyms:

1. **Independent agent plan review** is evidence from the configured secondary reviewer. It is not human approval and is not same-harness fallback evidence.
2. **Human feedback window** is an optional interval in which human comments can steer plan revision. It is not approval.
3. **Human attestation** is provenance or capability evidence. It is not plan sign-off.
4. **Human approval** or **human sign-off** is an affirmative human action that a control requires. It MAY be a direct per-action approval or one authenticated, immutable, expiring factory grant that names the later actions. A grant authorizes only its closed scope; it does not turn plan review into approval.

#### Scenario: Plan-review is described as independent agent review

- **WHEN** operator-facing documentation describes `plan-review` under the cross-harness path
- **THEN** it SHALL describe independent agent review of the implementation plan
- **AND** it SHALL NOT state that plan-review is human sign-off or human approval

#### Scenario: Human feedback window is named separately from approval

- **WHEN** operator-facing documentation describes human comments on the posted plan
- **THEN** it SHALL name an optional human feedback window or equivalent
- **AND** it SHALL NOT equate that window with approval or sign-off

#### Scenario: Attestation, grant, and plan-review remain distinct

- **WHEN** documentation describes Pipeline attestations or a signed scoped factory grant
- **THEN** it SHALL distinguish evidence from the human authorization event
- **AND** it SHALL NOT present agent plan-review evidence as the factory grant
- **AND** it SHALL state that the grant may authorize only the exact later mutations that it names

### Requirement: High-traffic operator copy SHALL NOT equate plan-review with human sign-off

The repository's front-door and packaging surfaces that introduce the lifecycle SHALL NOT claim that `plan-review` is human sign-off or human approval. They SHALL describe plan-review as independent agent review of the plan, with same-harness fallback disclosed when applicable, and an optional human feedback window before implementation. When they describe a scoped factory, they MAY state that a separate signed operator grant supplies human approval for the exact named issue merges and release actions.

#### Scenario: README Lifecycle band uses correct authority language

- **WHEN** a reader opens the README Lifecycle section or equivalent summary
- **THEN** the plan-review text SHALL describe independent agent plan review plus an optional human feedback window
- **AND** it SHALL NOT claim that plan-review is the human sign-off before implementation
- **AND** any scoped grant SHALL be described as a separate authorization event

#### Scenario: Examples show the authority boundary

- **WHEN** README or skill examples describe `steps.plan_review` or the plan-review path
- **THEN** agent plan-review SHALL remain the review evidence when enabled
- **AND** human comments SHALL remain optional steering
- **AND** a direct operator action or a separate valid scoped grant SHALL remain the merge authorization
- **AND** same-harness fallback SHALL NOT be presented as equivalent independent evidence
