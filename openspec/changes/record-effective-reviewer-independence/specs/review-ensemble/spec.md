## ADDED Requirements

### Requirement: Ensemble merge summary SHALL include independence coverage and aggregation outcome

When ensemble runs, the ensemble merge summary and multi-agent identity surface SHALL include coverage counts (`configured`, `attempted`, `usable`, `independent`, `required`), per-agent lineage fields required by reviewer-independence-quorum, and exactly one aggregation outcome from the closed set defined by reviewer-independence-quorum. The summary SHALL remain additive so older consumers that read only size/usable/failed continue to function.

#### Scenario: ensemble summary exposes counts and outcome

- **WHEN** an ensemble round completes with two usable agents and required 0
- **THEN** the ensemble meta/summary SHALL include configured, attempted, usable, independent, and required counts
- **AND** SHALL include a closed aggregation outcome
- **AND** SHALL still include usable/failed size fields used by #645 consumers

#### Scenario: single disposition still one comment

- **WHEN** ensemble records independence coverage
- **THEN** the engine SHALL still post exactly one disposition review comment for the round
- **AND** SHALL NOT require operators to reconcile N coverage comments

---

### Requirement: Ensemble soft-fail on min usable SHALL not satisfy an armed independent quorum alone

When `min_usable_agents` is met but an armed independent `required` count is not met, the ensemble path SHALL assign aggregation outcome `quorum_unmet` (after any one-shot substitute policy) and SHALL NOT treat the round as coverage-complete solely because min usable succeeded. When usable agents exist, union-merge of their findings SHALL still run. When usable agents are below `min_usable_agents`, the existing fail-closed path SHALL apply and map to `no_usable_reviewers` (or equivalent zero-usable coverage failure).

#### Scenario: min usable met but independent below required

- **WHEN** ensemble has min_usable_agents 1, two agents configured, one usable independent lineage, and required 2
- **THEN** the engine SHALL NOT advance as a normal coverage-complete ensemble success
- **AND** the aggregation outcome SHALL be `quorum_unmet`
- **AND** findings from the usable agent SHALL remain available on the merged set

#### Scenario: zero usable still fail closed

- **WHEN** every ensemble agent fails
- **THEN** the stage SHALL fail closed
- **AND** the aggregation outcome SHALL be `no_usable_reviewers`

---

### Requirement: Ensemble config MAY declare min independent by risk and substitute agents

The `review_ensemble` config object SHALL accept optional `min_independent_by_risk` (map of risk class to non-negative integer) and optional substitute agent list for a single repair wave. When ensemble is disabled, these fields SHALL NOT change single-reviewer latency beyond recording coverage for the one agent. Invalid negative minima SHALL fail config resolution.

#### Scenario: optional fields default inert

- **WHEN** `review_ensemble.enabled` is true and `min_independent_by_risk` is omitted
- **THEN** config resolution SHALL succeed
- **AND** required independent for rounds SHALL be 0 unless another armed policy supplies it

#### Scenario: substitute list is optional

- **WHEN** no substitute agents are configured
- **THEN** the engine SHALL skip the substitute wave
- **AND** SHALL evaluate quorum on the first attempt wave only

## MODIFIED Requirements

### Requirement: Ensemble SHALL produce one disposition surface with multi-agent audit identity

Each ensemble review round SHALL post exactly one review comment / review artifact for disposition
purposes and SHALL expose exactly one merged finding set and one blocking-key set to fix rounds,
ceiling, settled-surface matching, overrides, and pre-merge SHA-gate consumers. The round record
SHALL include per-agent identity for audit: configured harness, effective harness, model when
known, provider family, model family, self_review flag, cost when known, usable/failed status,
latency when known, and failure/fallback reason when not usable. The round record SHALL also
include coverage counts (`configured`, `attempted`, `usable`, `independent`, `required`) and the
closed aggregation outcome. Schema changes for these fields SHALL be additive so single-agent
rounds remain valid.

#### Scenario: single comment for multi-agent round

- **WHEN** an ensemble round with two usable agents completes
- **THEN** the engine SHALL post one disposition review comment for that round
- **AND** SHALL NOT require operators to reconcile N independent approve/block comments

#### Scenario: downstream sees one finding set

- **WHEN** ensemble merge produces three distinct findings after dedupe
- **THEN** fix / ceiling / override / settled-surface consumers for that round SHALL observe those
  three findings (and their keys) as the round’s sole finding set

#### Scenario: multi-agent identity is recorded

- **WHEN** an ensemble round completes with agents codex and claude
- **THEN** the persisted round identity SHALL list both agents with harness and self_review fields
- **AND** SHALL record ensemble size and usable/failed counts or equivalent merge summary fields
- **AND** SHALL record provider_family and model_family (or unknown) for each agent
- **AND** SHALL record coverage counts and aggregation outcome

#### Scenario: coverage disclosure on disposition

- **WHEN** an ensemble round completes with aggregation outcome `same_lineage_fallback`
- **THEN** the single disposition surface SHALL disclose the outcome and that independence was degraded
- **AND** SHALL NOT present the round as fully multi-lineage independent coverage
