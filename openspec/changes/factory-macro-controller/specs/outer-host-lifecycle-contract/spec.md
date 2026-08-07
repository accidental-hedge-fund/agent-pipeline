## ADDED Requirements

### Requirement: Outer-host identity SHALL remain distinct from factory service-controller identity

When a factory macro-controller run records outer-host lifecycle identity, that outer-host id SHALL remain a field independent of the factory **service controller** identity as well as independent of implementer and reviewer treatment (adapter) identity. Shared orchestration and factory evidence writers SHALL NOT rewrite outer-host id to equal the service controller id, and SHALL NOT rewrite service controller id to equal outer-host id or any stage adapter id.

#### Scenario: Factory evidence keeps three-way separation

- **WHEN** a factory run is supervised by outer host `grok` with service controller `factory-macro@1` and implementer treatment `codex`
- **THEN** durable factory evidence SHALL record outer-host `grok`, service controller `factory-macro@1`, and implementer treatment `codex` as distinct fields
- **AND** none of those three fields SHALL be forced equal by a silent remapping rule

#### Scenario: Unknown outer host is not invented from controller id

- **WHEN** the outer host is unknown for a factory tick
- **THEN** the outer-host field SHALL be omitted or set to an explicit unknown value
- **AND** the system SHALL NOT copy the service controller identity into the outer-host field as a substitute
