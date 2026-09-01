## ADDED Requirements

### Requirement: Factory scoreboard SHALL report unique-operation reliability from shared correlated facts

`pipeline scoreboard` SHALL include an additive unique-operation reliability section computed from persisted `logical_operation_id` values and the same classifier used by FRG `operation_reliability`. The section SHALL expose numerators, denominators, stable exclusions, and missing-correlation counts for: admission-to-verified-completion without Manual reinvocation; false-human projection; ownerless terminals; exact-candidate recovery; and independent-sibling continuation. Attempt counts, raw run counts, and closed-issue counts SHALL NOT be used as the unique-operation success-rate denominator. The command SHALL remain read-only.

#### Scenario: JSON exposes unique-operation rates with explicit denominators

- **WHEN** the window contains two physical runs that share one `logical_operation_id` and that operation reached verified completion, plus one distinct logical operation that did not
- **AND** `pipeline scoreboard --json` is invoked
- **THEN** the unique-operation completion denominator SHALL be `2`
- **AND** the unique-operation completion numerator SHALL be `1`
- **AND** the two physical runs SHALL NOT produce denominator `3`

#### Scenario: Attempt metrics are not substituted for unique-operation success

- **WHEN** ten physical runs exist for three logical operations
- **THEN** unique-operation success-rate denominator SHALL be `3`
- **AND** any attempt-based metric MAY still report ten runs when labeled as an attempt metric

#### Scenario: Scoreboard does not reclassify labels independently

- **WHEN** GitHub issues in the window are closed or carry `pipeline:ready-to-deploy`
- **AND** correlated `logical_operation_id` evidence is missing
- **THEN** the scoreboard SHALL increment missing-correlation counts
- **AND** SHALL NOT count those issues as unique-operation verified successes from labels alone

---

### Requirement: Factory scoreboard unique-operation section SHALL tolerate historical runs without logical identity

Runs whose artifacts predate `logical_operation_id` SHALL contribute to missing-correlation diagnostics rather than crashing the scoreboard. The scanner SHALL NOT invent a logical identity from issue number, recency, or `run_id`. Historical missing correlation SHALL NOT be treated as a stable exclusion from unique-operation SLOs.

#### Scenario: Pre-identity run is diagnosed

- **WHEN** an included run has `run.json` and events but no `logical_operation_id`
- **THEN** that run SHALL be omitted from unique-operation numerators and denominators
- **AND** diagnostics SHALL include a stable missing-correlation code
- **AND** other attempt-based metrics for that run MAY still be reported
