## ADDED Requirements

### Requirement: summary.json SHALL record pre-merge delta-round accounting

When a run performs at least one pre-merge delta round, `summary.json` SHALL include a delta-round accounting record carrying: the durable delta-round count observed for the item, the configured `review_policy.max_delta_rounds` cap, the ceiling disposition when the cap was reached (the applied `ceiling_action` and whether the item parked or advanced), and the rounds flagged as suspected churn with their involved axes. The human-readable summary SHALL render the count, the cap, and any ceiling disposition. Recording this accounting SHALL be non-fatal: a write failure SHALL NOT fail the run or change the pre-merge outcome.

#### Scenario: Bundle reports count, cap, and ceiling disposition

- **WHEN** a run performs delta rounds and reaches the configured cap
- **THEN** `summary.json` SHALL report the observed delta-round count, the cap, and the applied `ceiling_action` with the resulting disposition

#### Scenario: Churn flags are recorded

- **WHEN** a delta round was flagged as suspected churn
- **THEN** `summary.json` SHALL list that round among the suspected-churn rounds with its involved axes

#### Scenario: Human-readable summary renders the accounting

- **WHEN** the human-readable summary is printed for a run that performed delta rounds
- **THEN** it SHALL show the delta-round count, the cap, and any ceiling disposition

#### Scenario: No delta rounds — no record required

- **WHEN** a run performs no pre-merge delta rounds
- **THEN** `summary.json` SHALL be valid without a delta-round accounting record

#### Scenario: Write failure is non-fatal

- **WHEN** writing the delta-round accounting record fails
- **THEN** the run SHALL continue and the pre-merge outcome SHALL be unchanged
