## ADDED Requirements

### Requirement: Attribution target types SHALL include production_outcome for planning-leverage joins

The outcome-linkage attribution model SHALL allow `target_type: "production_outcome"` with `target_id` equal to a durable `outcome_id` from the production-outcome store when evidence supports the join. Planning-leverage and material-rework telemetry MAY reuse the same attribution entry shape (`target_type`, `target_id`, `method`, `authority`, optional `confidence`, optional redacted `note`) so reports can join planning investment to #576 outcomes without inventing ids.

Producers SHALL set `authority: "observed"` only when the outcome_id is taken from a durable outcome record or an explicit operator/manual mapping. Heuristic co-occurrence alone SHALL use `authority: "inferred"`. Absence of a production outcome SHALL omit the entry rather than fabricating an outcome_id.

Existing target types (`run`, `commit`, `pr`, `issue`, `component`) SHALL remain valid. Adding `production_outcome` SHALL NOT remove or rename them.

#### Scenario: observed production_outcome attribution is allowed

- **WHEN** a planning-leverage snapshot links to an existing outcome with `outcome_id: "out-1"` present in the local outcome store
- **THEN** an attribution entry MAY include `target_type: "production_outcome"`, `target_id: "out-1"`, and `authority: "observed"` when the link is direct or manual with evidence

#### Scenario: missing outcome id is not fabricated

- **WHEN** no production-outcome record exists for a run
- **THEN** producers SHALL omit `production_outcome` attribution
- **AND** SHALL NOT write a placeholder `target_id` that is not a real outcome_id

#### Scenario: temporal co-occurrence alone is inferred

- **WHEN** the only link between planning-leverage telemetry and an outcome is same-day same-repo co-occurrence without shared run_id, SHA, or trailer evidence
- **THEN** any `production_outcome` attribution written from that join SHALL use `authority: "inferred"`
- **AND** SHALL NOT be labeled `observed`

---

### Requirement: Linkage helpers used for planning-leverage joins SHALL remain pure and offline-testable

Helpers that resolve planning-leverage or material-rework records to production outcomes, runs, commits, PRs, issues, or components SHALL be pure or deps-injected and unit-testable without live network or real git. Tests SHALL cover successful observed joins, unresolved cases, and inferred vs observed classification for `production_outcome` targets.

#### Scenario: run_id match to outcome attribution is observed

- **WHEN** helpers are given a planning-leverage record with `run_id: R` and an outcome whose attribution already includes observed run `R`
- **THEN** the helper MAY produce a `production_outcome` attribution with `authority: "observed"` when the outcome_id is taken from that store record

#### Scenario: unresolved outcome does not throw

- **WHEN** helpers cannot resolve any production outcome for a run
- **THEN** they SHALL return an empty or diagnostic result
- **AND** SHALL NOT throw an unhandled exception
