## ADDED Requirements

### Requirement: Factory scoreboard SHALL account for review ensemble size and per-agent cost when present

When included run artifacts record a review ensemble for a round, the factory scoreboard SHALL
account for ensemble size, per-agent harness costs (when cost is present on agent records), and
merge/usable/failure summary fields rather than attributing the round solely to a primary harness.
Harness-calls and cost-per-ready-PR style metrics SHALL count every ensemble agent invocation that
the run recorded. Same-harness self-review rate SHALL continue to count self-review **per agent**
when ensemble data marks individual agents as self-review. Runs without ensemble fields SHALL
remain valid scoreboard inputs with unchanged single-reviewer accounting.

The scoreboard command SHALL remain read-only.

#### Scenario: ensemble costs sum across agents

- **WHEN** an included run has a review round with two ensemble agents reporting costs `1.0` and
  `2.0` USD (or the run’s native cost unit)
- **THEN** harness cost aggregation for that run SHALL include both amounts
- **AND** SHALL NOT drop the non-primary agent’s cost solely because ensemble ran

#### Scenario: ensemble size is visible in metrics or diagnostics

- **WHEN** included runs contain ensemble rounds with sizes 2 and 3
- **THEN** the scoreboard report SHALL expose ensemble size information (metric and/or diagnostic
  breakdown) so operators can see that multi-agent review ran
- **AND** single-agent runs without ensemble fields SHALL NOT be treated as errors

#### Scenario: per-agent self-review still counts

- **WHEN** an ensemble round records one agent with `selfReview: true` and one with
  `selfReview: false`
- **THEN** the same-harness fallback accounting SHALL count the self-review agent
- **AND** SHALL NOT treat the entire ensemble round as a single non-self-review solely because one
  agent was independent

#### Scenario: scoreboard remains read-only with ensemble fields

- **WHEN** `pipeline scoreboard` scans runs that include ensemble identity fields
- **THEN** no GitHub mutation SHALL occur
- **AND** no file under `.agent-pipeline/runs/` SHALL be created, modified, or deleted
