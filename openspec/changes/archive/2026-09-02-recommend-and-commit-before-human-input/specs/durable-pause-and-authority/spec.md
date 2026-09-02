## MODIFIED Requirements

### Requirement: Every waiting transition SHALL record a precise human-input request

The engine SHALL require, on every transition into `waiting`, a structured human-input request naming the item id, a request kind drawn from the closed set `decision`, `answer`, or `authority-grant`, the prompt describing what is needed, an optional closed set of permitted responses, and the requesting engine and time. Those kinds SHALL be compatibility aliases of the public typed-request union: `decision` SHALL mean `DecisionRequest`, `answer` SHALL mean `CapabilityRequest` (required information is a CapabilityRequest reason, not a fourth type), and `authority-grant` SHALL mean `AuthorityRequest`. A product `decision` SHALL NOT be treated as `authority-grant`. The request SHALL be persisted with the item in the durable ledger and assigned a request id unique within the run. A `waiting` transition SHALL persist the matching classifier record: a `DecisionRequest` package, a `CapabilityRequest` probe record, or `AuthorityRequest` bindings. A `waiting` transition that supplies no request, an unknown request kind, a request whose permitted-response set is present but empty, or an incomplete typed-request record SHALL be refused as a validation failure leaving durable state unchanged. Auto-settled recommendations SHALL NOT enter `waiting`. Resume SHALL validate against that persisted record. A persisted `waiting` hold that lacks the matching classifier record SHALL NOT be resumed by synthesizing typed-request fields; Pipeline SHALL invalidate that hold and re-admit the item through the shared classifier.

#### Scenario: A waiting transition without a request is refused

- **WHEN** a transition to `waiting` supplies no human-input request
- **THEN** it SHALL be refused as a validation failure
- **AND** the item's state SHALL be unchanged

#### Scenario: A request with a closed response set records its options

- **WHEN** a `waiting` transition supplies a request of kind `decision` with a non-empty permitted
  response set
- **THEN** the request SHALL be persisted with the item, carrying its request id, kind, prompt,
  permitted responses, requesting engine, and time

#### Scenario: An unknown request kind is refused

- **WHEN** a `waiting` transition supplies a request whose kind is not one of `decision`, `answer`,
  or `authority-grant`
- **THEN** it SHALL be refused as a validation failure naming the offending kind

#### Scenario: Answer kind is CapabilityRequest not authority

- **WHEN** a `waiting` transition supplies kind `answer` for missing information
- **THEN** Pipeline SHALL project that request as a `CapabilityRequest`
- **AND** SHALL NOT treat it as `authority-grant` or `missing-authority`

#### Scenario: Decision kind is not an authority grant

- **WHEN** a `waiting` transition supplies kind `decision` for contradictory product requirements
- **THEN** Pipeline SHALL project that request as a `DecisionRequest`
- **AND** SHALL NOT treat the request as an authority grant

#### Scenario: Incomplete typed-request record is refused

- **WHEN** a `waiting` transition supplies kind `decision` without recommendation, rationale, alternatives, risk, and evidence
- **THEN** it SHALL be refused as a validation failure
- **AND** the item's state SHALL be unchanged

#### Scenario: Legacy waiting hold without a typed-request package is re-admitted

- **WHEN** a `waiting` item's persisted hold has kind `decision`, `answer`, or `authority-grant` but lacks the matching classifier record
- **AND** a resume names that outstanding request
- **THEN** Pipeline SHALL NOT synthesize typed-request fields
- **AND** SHALL NOT leave the item waiting
- **AND** SHALL invalidate the hold and re-admit the item through the shared classifier
