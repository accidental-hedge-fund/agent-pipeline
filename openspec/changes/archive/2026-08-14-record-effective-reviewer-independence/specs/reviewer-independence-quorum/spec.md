## Purpose

Defines typed reviewer lineage, pure independence counting, coverage tallies, optional risk-class independent quorum, deterministic aggregation outcomes, cost coverage classes, and fail-closed recovery/escalation so readiness evidence reports effective independent review coverage rather than configured intent alone.

## ADDED Requirements

### Requirement: Every reviewer attempt SHALL record typed lineage and attempt metadata

For each reviewer attempt on a review round that uses the shared reviewer seam (ensemble or single-reviewer), the engine SHALL record a typed attempt record with at least: `configured_harness`, `effective_harness`, `provider_family`, `model_family`, `model` when known, `self_review` boolean, `implementer_harness`, usability status (`usable` or `failed`), `latency_ms` or an explicit unknown/null latency, a cost coverage class for that attempt, and when not usable a closed failure or fallback reason (including self-review fallback). Provider family and model family SHALL come from a documented deterministic mapping over harness and model identifiers (with a closed `unknown` value). The engine SHALL NOT derive lineage from Project Warrant, reviewer free text, or model prose.

#### Scenario: usable independent agent records lineage

- **WHEN** a configured non-implementer reviewer harness completes with a usable verdict and no self-review fallback
- **THEN** the attempt record SHALL include that harness as configured and effective
- **AND** SHALL set `self_review` to false
- **AND** SHALL set non-empty `provider_family` and `model_family` values drawn from the deterministic map or `unknown`

#### Scenario: self-review fallback is labeled on the attempt

- **WHEN** an agent’s configured CLI fails with spawn_error and the agent completes via implementer same-harness self-review
- **THEN** the attempt record SHALL set `self_review` to true
- **AND** SHALL set `effective_harness` to the implementer harness
- **AND** SHALL record a fallback reason that identifies self-review

#### Scenario: failed attempt records failure reason

- **WHEN** an agent times out or returns unparseable output
- **THEN** the attempt SHALL be marked not usable
- **AND** SHALL carry a closed failure reason such as timeout or unparseable
- **AND** SHALL still record configured harness and lineage fields that were known before failure

#### Scenario: lineage is not inferred from Warrant or prose

- **WHEN** Project Warrant metadata or reviewer summary text claims a provider family
- **THEN** the engine SHALL ignore that claim for attempt lineage fields
- **AND** SHALL populate lineage only from the deterministic harness/model mapping and runtime harness identity

---

### Requirement: Independence SHALL be computed by documented pure rules

The engine SHALL compute whether each usable attempt is **independently eligible** using only typed attempt fields and policy. An attempt is independently eligible only when it is usable, `self_review` is false, and `effective_harness` is not the implementer harness. The round’s **independent count** SHALL equal the number of distinct `lineage_key` values among independently eligible attempts, where `lineage_key` is the pair `(provider_family, model_family)` and agents are considered in configured order (first agent for a key occupies the independent slot). Self-review attempts SHALL NOT increment the independent count. Two usable agents that share the same `lineage_key` SHALL contribute at most one to the independent count. Independence SHALL NOT be inferred by Project Warrant or free text.

#### Scenario: self-review is never independent

- **WHEN** the only usable attempt is a same-harness self-review
- **THEN** the independent count SHALL be 0
- **AND** the attempt SHALL remain usable for union-merge when otherwise valid

#### Scenario: same provider and model family share one independent slot

- **WHEN** two usable non-self-review agents map to the same `provider_family` and `model_family`
- **THEN** the independent count SHALL be 1
- **AND** both agents SHALL remain usable for union-merge of findings

#### Scenario: distinct lineage keys count as two independents

- **WHEN** two usable non-self-review agents map to different `lineage_key` values
- **THEN** the independent count SHALL be 2

#### Scenario: implementer effective harness is not independent

- **WHEN** an attempt is usable but `effective_harness` equals the implementer harness
- **THEN** that attempt SHALL NOT be independently eligible
- **AND** SHALL NOT increment the independent count

---

### Requirement: Each review round SHALL record explicit coverage counts

Each review round on the shared reviewer seam SHALL persist integer coverage counts: `configured` (resolved agent list length; 1 when ensemble is off), `attempted` (agents the engine started or tried to start), `usable` (attempts that produced a usable verdict under existing ensemble usable rules), `independent` (from the independence rule), and `required` (minimum independent reviewers demanded by risk-class policy for this round, or 0 when no quorum is armed). Counts SHALL be consistent with the attempt records for that round.

#### Scenario: single-reviewer round has configured 1

- **WHEN** ensemble is disabled and one reviewer runs
- **THEN** `configured` SHALL be 1
- **AND** `attempted` SHALL be 1 when the invoke is started
- **AND** `usable` and `independent` SHALL reflect that single attempt under the independence rules
- **AND** `required` SHALL be 0 when no min-independent policy is armed

#### Scenario: partial fan-out records attempted less than configured only when some never start

- **WHEN** ensemble configures three agents and the engine starts all three
- **THEN** `configured` and `attempted` SHALL both be 3
- **AND** `usable` SHALL equal the number of usable verdicts

#### Scenario: independent and usable diverge on lineage collapse

- **WHEN** two agents are usable and share one lineage_key and neither is self-review
- **THEN** `usable` SHALL be 2
- **AND** `independent` SHALL be 1

---

### Requirement: Optional risk-class policy SHALL set required independent quorum

The pipeline config schema SHALL accept an optional mapping of risk class to minimum independent reviewer count (for example under `review_ensemble.min_independent_by_risk`). When the mapping is absent or the resolved class entry is missing or zero, `required` SHALL be 0 and existing min-usable behavior SHALL remain the coverage gate. When a positive `required` is armed for the round’s resolved risk class, the engine SHALL treat independent quorum as a readiness constraint for that round. Config resolution SHALL reject negative counts. The engine SHALL NOT require multiple providers for every repository by default.

#### Scenario: unset mapping leaves required at zero

- **WHEN** `min_independent_by_risk` is absent
- **AND** a review round completes with one usable independent agent
- **THEN** `required` SHALL be 0
- **AND** the round SHALL NOT fail solely for independent quorum

#### Scenario: high risk requires two independents

- **WHEN** the round’s resolved risk class is `high` and config sets `min_independent_by_risk.high` to 2
- **AND** only one independently eligible lineage is usable
- **THEN** `required` SHALL be 2
- **AND** `independent` SHALL be 1
- **AND** the aggregation outcome SHALL be `quorum_unmet` (after any configured substitute attempt)

#### Scenario: negative minimum is rejected

- **WHEN** an operator sets a negative min independent count for any risk class
- **THEN** config resolution SHALL fail with an actionable message naming the invalid field

---

### Requirement: Aggregation outcome SHALL be one closed value with an explanatory reason

After attempts settle (and after any single configured substitute attempt), the engine SHALL assign exactly one aggregation outcome from this closed set:

- `complete` — usable equals configured, usable meets min usable, and independent meets required
- `partial_quorum` — usable is less than configured, usable meets min usable, and independent meets required
- `same_lineage_fallback` — usable meets min usable, independent meets required (including required 0), and coverage is independence-degraded (self-review present among usable agents and/or lineage collapse reduced independent below usable)
- `quorum_unmet` — independent is less than required
- `no_usable_reviewers` — usable is zero or below `min_usable_agents`

The round record SHALL include a short machine-readable reason string that explains why the set was complete, degraded, or blocked (counts and the dominant cause). The engine SHALL NOT invent majority-vote approval outcomes.

#### Scenario: full success is complete

- **WHEN** two of two configured agents are usable with distinct lineage keys and required is 2
- **THEN** the aggregation outcome SHALL be `complete`

#### Scenario: one timeout with quorum still met is partial_quorum

- **WHEN** three agents are configured, two are usable with distinct lineage keys, one times out, required is 2, and min usable is 1
- **THEN** the aggregation outcome SHALL be `partial_quorum`
- **AND** the reason SHALL mention the failed agent or timeout class

#### Scenario: self-review only with required zero is same_lineage_fallback

- **WHEN** the only usable agent is self-review, min usable is 1, and required is 0
- **THEN** the aggregation outcome SHALL be `same_lineage_fallback`
- **AND** the reason SHALL disclose self-review

#### Scenario: high-risk one lineage is quorum_unmet

- **WHEN** required is 2 and independent is 1 after substitute policy runs
- **THEN** the aggregation outcome SHALL be `quorum_unmet`
- **AND** the reason SHALL include independent and required counts

#### Scenario: all agents fail is no_usable_reviewers

- **WHEN** every agent fails or is unparseable
- **THEN** the aggregation outcome SHALL be `no_usable_reviewers`
- **AND** the round SHALL NOT be treated as an approve

---

### Requirement: Union-merge rigor SHALL hold under every aggregation outcome

When any agents are usable, the engine SHALL still union-merge their findings with existing `findingKey` dedupe and rigor-first blocking. Missing agents, non-independent agents, or an unmet quorum SHALL NOT erase a policy-blocking finding contributed by a usable agent. Unmet independent quorum SHALL NOT convert the round into a majority approve. When outcome is `quorum_unmet` and usable agents produced findings, the persisted finding set SHALL still include the union of those findings.

#### Scenario: blocking finding survives quorum_unmet

- **WHEN** required is 2, only one independent lineage is usable, and that agent reports a policy-blocking finding
- **THEN** the merged finding set SHALL include that finding
- **AND** the aggregation outcome SHALL be `quorum_unmet`
- **AND** the engine SHALL NOT drop the finding because quorum failed

#### Scenario: no majority approve on split verdicts

- **WHEN** agent A approves with zero findings and agent B reports a policy-blocking finding
- **THEN** the merged path SHALL retain B’s finding as blocking under active policy
- **AND** the engine SHALL NOT approve solely because A approved

---

### Requirement: Cost coverage SHALL distinguish requested, attempted, completed, and billable

For each review round the engine SHALL record cost/coverage dimensions that distinguish at least: **requested** (configured agent count / planned work), **attempted** (invokes started), **completed** (invokes that reached a terminal harness result), and **billable** (completed attempts with known actual or estimated cost under stage-cost-accounting rules). When cost is unknown, the attempt SHALL be completed without inventing a billable zero-dollar actual. Rollups MAY include USD sums only for known cost sources.

#### Scenario: timeout is attempted and completed but not billable without cost

- **WHEN** an agent is started and times out with no cost data
- **THEN** it SHALL count toward attempted and completed
- **AND** SHALL NOT count as billable with a fabricated actual cost of zero

#### Scenario: requested reflects configured fan-out

- **WHEN** ensemble configures three agents and only two are started due to a pre-start rejection of one
- **THEN** requested SHALL remain 3
- **AND** attempted SHALL be 2

#### Scenario: known cost is billable

- **WHEN** a usable agent completes with cost_source actual or estimated and a non-null cost
- **THEN** that attempt SHALL count as billable for the round rollup

---

### Requirement: quorum_unmet and no_usable_reviewers SHALL fail closed with typed recovery

Outcomes `quorum_unmet` and `no_usable_reviewers` SHALL fail closed for coverage readiness: the engine SHALL NOT treat the round as a normal coverage-complete approve path. Before terminal escalation, when configuration supplies substitute agents or unused configured agents that can improve independence, the engine MAY perform **at most one** substitute independent attempt wave and recompute counts and outcome. After that bound, the engine SHALL escalate through a typed production escalation site registered in the escalation-site inventory, with a `BlockerKind` (or equivalent) that has a non-empty static recovery recipe. These outcomes SHALL NOT default to product-judgment `needs-human` solely because coverage failed. Optional config that allows degrade-on-quorum-unmet SHALL default to false; when true it MAY proceed only with loud advisory coverage disclosure and SHALL still preserve union blockers.

#### Scenario: no usable reviewers blocks without approve

- **WHEN** outcome is `no_usable_reviewers` after any one-shot substitute policy
- **THEN** the stage SHALL block
- **AND** SHALL NOT post or route an approve verdict
- **AND** the block SHALL name a typed no-usable-reviewers class and recovery recipe

#### Scenario: quorum unmet blocks coverage even if min usable met

- **WHEN** usable meets `min_usable_agents` but independent is less than required
- **THEN** outcome SHALL be `quorum_unmet`
- **AND** the engine SHALL NOT advance as coverage-complete approve solely because min usable was met
- **AND** the escalation or block record SHALL include independent and required counts

#### Scenario: one-shot substitute can repair quorum

- **WHEN** the first wave yields independent 1 with required 2
- **AND** a configured substitute agent with a distinct lineage_key returns a usable non-self-review verdict on the single substitute wave
- **THEN** the engine SHALL recompute independent count
- **AND** when independent becomes 2 the outcome SHALL NOT remain `quorum_unmet`

#### Scenario: degrade flag defaults off

- **WHEN** quorum is unmet and degrade-on-quorum-unmet is unset or false
- **THEN** the engine SHALL NOT silently continue as if coverage were complete
- **AND** SHALL escalate or block with the quorum recipe

#### Scenario: escalation site is inventory-backed

- **WHEN** a new production block for quorum_unmet or no_usable_reviewers is emitted
- **THEN** the site SHALL appear in the escalation-site disposition inventory with a closed safety disposition
- **AND** SHALL carry a typed reason projection suitable for stage diagnostics
