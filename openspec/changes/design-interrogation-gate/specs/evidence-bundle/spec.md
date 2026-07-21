## ADDED Requirements

### Requirement: Bundle records the design-interrogation chain

The evidence bundle SHALL carry a `designInterrogation` record for every run that reaches the
`design-gate` stage. When the gate does not fire, the record SHALL contain `triggered: false` and the
reason (`gate-disabled` or `no-trigger-matched`) and nothing else. When the gate fires, the record
SHALL additionally contain: the matched triggers with their evidence, `reviewerIdentity`
(harness, model, effort) and `reviewerIndependence`, every version of the decision record, every
round's challenges (each with `challengeKey`, severity, confidence, blocking-vs-advisory disposition,
and `required_action`), the implementer's response for each challenge with its final disposition, and
the gate's final outcome (`advanced`, `parked-needs-human`, or `blocked`). The record SHALL be subject
to the bundle's existing secret-redaction rules and SHALL contain no raw hidden model reasoning.

#### Scenario: untriggered run records only the reason
- **WHEN** the gate is disabled and the run finalizes
- **THEN** `summary.json` SHALL contain a `designInterrogation` record with `triggered: false` and reason `gate-disabled`
- **AND** the record SHALL contain no decision record, challenges, or reviewer identity

#### Scenario: triggered run records the full chain
- **WHEN** the gate fires, the reviewer returns challenges, and the implementer responds
- **THEN** `summary.json` SHALL contain the matched triggers, the reviewer identity and independence value, each decision-record version, each round's challenges with their keys and dispositions, the implementer responses, and the final gate outcome

#### Scenario: parked run records the unresolved punch list
- **WHEN** the gate parks at `needs-human`
- **THEN** the `designInterrogation` record SHALL carry outcome `parked-needs-human`
- **AND** SHALL list each unresolved blocking challenge with its `challengeKey`, severity, and `required_action`

#### Scenario: redaction applied
- **WHEN** any part of the chain contains a value matching the engine's secret patterns
- **THEN** the persisted bundle SHALL carry the redacted form

---

### Requirement: The human-readable summary SHALL render the design-interrogation outcome

The run summary posted for the issue SHALL include a design-interrogation section whenever the gate
fired, naming the matched trigger classes, the reviewer identity with any same-harness fallback
disclosure, the count of blocking and advisory challenges, each challenge's final disposition, and any
explicitly accepted uncertainty. When the gate did not fire, the summary SHALL state the one-line
reason rather than omitting the gate entirely.

#### Scenario: fired gate rendered in the summary
- **WHEN** the gate fired and the run finalizes
- **THEN** the posted summary SHALL contain a design-interrogation section with the matched triggers, reviewer identity, challenge counts, and per-challenge dispositions

#### Scenario: same-harness fallback disclosed in the summary
- **WHEN** the gate ran under `same-harness-fallback`
- **THEN** the summary section SHALL state the fallback explicitly

#### Scenario: untriggered gate rendered as a one-line reason
- **WHEN** the gate did not fire
- **THEN** the summary SHALL contain a one-line design-gate reason (`gate-disabled` or `no-trigger-matched`)
