# outcome-linkage Specification

## Purpose
TBD - created by archiving change production-outcome-linkage. Update Purpose after archive.

## Requirements

### Requirement: Outcomes SHALL link to runs, commits, pull requests, issues, and components when evidence exists

Each `production_outcome` SHALL carry an `attribution` array. Each attribution entry SHALL include at least:

- `target_type` — one of `run`, `commit`, `pr`, `issue`, `component`
- `target_id` — string identity for that target (`run_id`, full commit SHA, PR number as string, issue number as string, or component key)
- `method` — one of `direct`, `trailer`, `heuristic`, `manual`, `adapter`
- `authority` — one of `observed`, `inferred`
- `confidence` — number in `[0, 1]` or null when unknown
- optional bounded redacted `note`

When evidence for a target class is absent, the entry SHALL be omitted or the field set null with a documented missing-link reason on the parent record (`linkage_diagnostics` array of stable reason codes). Producers SHALL NOT invent run ids, SHAs, or PR numbers to force a link.

#### Scenario: multi-target linkage is allowed

- **WHEN** an outcome is linked to a run id, a merge commit SHA, and a component key with evidence for each
- **THEN** `attribution` SHALL contain three entries with the corresponding `target_type` values
- **AND** no requirement SHALL force exactly one primary target

#### Scenario: missing run link is explicit

- **WHEN** a revert signal has a PR number but no resolvable `run_id`
- **THEN** the outcome MAY include a `pr` attribution without a `run` attribution
- **AND** `linkage_diagnostics` SHALL include a stable code such as `unresolved_run_id` rather than fabricating a run id

#### Scenario: invented identity is forbidden

- **WHEN** an adapter cannot resolve a candidate SHA from the signal or local run store
- **THEN** it SHALL leave commit attribution absent or null
- **AND** SHALL NOT write a placeholder SHA that looks valid

---

### Requirement: Attribution authority SHALL distinguish observed facts from inferred claims

An attribution entry with `authority: "observed"` SHALL be used only when the linkage is supported by direct durable evidence (for example: `Pipeline-Run` trailer match, run store identity fields, explicit adapter mapping from a deployment SHA equal to the candidate SHA, or an operator `manual` record). Heuristic joins (same component path co-occurrence, temporal proximity alone, free-text title similarity) SHALL set `authority: "inferred"` and SHOULD set a non-null `confidence` when a score is computed. Reporting consumers SHALL treat inferred attribution as non-authoritative for claims of production success or failure of a specific run.

#### Scenario: trailer match is observed authority

- **WHEN** a merge commit carries `Pipeline-Run: 576/2026-08-13T15:47:45Z` and a matching run directory exists
- **THEN** the run attribution entry SHALL use `method: "trailer"` or `method: "direct"`
- **AND** `authority` SHALL be `observed`

#### Scenario: temporal co-occurrence alone is inferred

- **WHEN** the only link between an incident signal and a run is that both occurred in the same day for the same repo with no SHA/trailer/PR join
- **THEN** any run attribution written from that join SHALL have `authority: "inferred"`
- **AND** SHALL NOT be labeled `observed`

#### Scenario: reporting separates authorities

- **WHEN** an outcome has one observed PR attribution and one inferred run attribution
- **THEN** a reporting consumer that exposes both SHALL label or partition them so inferred is not presented as observed fact

---

### Requirement: Disputed and many-to-many attribution SHALL be first-class

Multiple attribution entries for the same or different target types MAY coexist on one outcome (many-to-many). When two sources disagree about a target, the outcome SHALL set `observation_state: "disputed"` or record per-entry dispute markers without deleting prior entries. Consumers SHALL surface dispute rather than silently picking a winner.

#### Scenario: two candidate runs remain both linked when disputed

- **WHEN** two adapters attribute the same reversion signal to different `run_id` values
- **THEN** the stored outcome SHALL retain both attribution entries (or linked disputed records)
- **AND** `observation_state` SHALL be `disputed` or each conflicting entry SHALL carry an explicit dispute marker
- **AND** the store SHALL NOT keep only the last writer without a dispute signal

#### Scenario: many-to-many component and PR linkage

- **WHEN** a change amplification outcome touches three components and two PRs
- **THEN** `attribution` SHALL allow multiple `component` and multiple `pr` entries
- **AND** validation SHALL NOT reject the record for lacking a single primary key

---

### Requirement: Linkage helpers SHALL be pure and offline-testable against run store and trailers

The engine SHALL provide pure (or deps-injected) helpers that resolve candidate linkages from: run store identity (`run_id`, issue, pr, candidate SHA), commit trailers (`Issue`, `Pipeline-Run`), and adapter-normalized signal fields. Unit tests SHALL cover successful trailer→run resolution, unresolved cases, and inferred vs observed classification without live network or real git.

#### Scenario: trailer to run resolution

- **WHEN** helpers are given a commit message with `Pipeline-Run: 42/2026-06-08T14:32:00Z` and a run store fixture containing that run id
- **THEN** the helper SHALL produce a run attribution with `authority: "observed"`

#### Scenario: unresolved trailer does not crash

- **WHEN** a trailer references a run id absent from the local store
- **THEN** the helper SHALL return an unresolved diagnostic
- **AND** SHALL NOT throw an unhandled exception

#### Scenario: candidate SHA exact match is observed run link

- **WHEN** helpers are given a merge or deployment SHA equal to a run store `candidate_sha`
- **THEN** the helper SHALL emit a `run` attribution with `method: "direct"` and `authority: "observed"`
- **AND** SHALL still include a `commit` attribution for that SHA when valid

#### Scenario: multiple candidate SHA matches stay disputed

- **WHEN** two or more runs share the same `candidate_sha` equal to the signal SHA
- **THEN** the helper SHALL retain a `run` attribution for each match
- **AND** SHALL mark them disputed (per-entry and/or `disputed_targets` diagnostic)
- **AND** SHALL NOT silently keep only one run

### Requirement: Production outcomes SHALL be projectable into the intent-lineage graph without a parallel attribution model

When lineage ingest is available, each `production_outcome` and its `attribution` entries SHALL be projectable into intent-lineage nodes and edges that preserve:

- multi-target many-to-many attribution
- `authority` values `observed` vs `inferred`
- disputed and missing-link diagnostics

Lineage projection SHALL reuse outcome_id and attribution target identities rather than minting a second incompatible attribution store. Projection SHALL NOT collapse multiple outcomes into a single maintainability score.

#### Scenario: observed run attribution becomes an observed lineage edge

- **WHEN** an outcome has a run attribution with `authority: "observed"`
- **THEN** the projected lineage edge for that run target SHALL carry authority `observed`
- **AND** SHALL reference the same `run_id` target identity

#### Scenario: inferred attribution remains inferred in lineage

- **WHEN** an outcome has only an inferred component attribution
- **THEN** the projected lineage edge SHALL carry authority `inferred`
- **AND** reporting consumers SHALL NOT present it as observed fact

#### Scenario: many-to-many outcomes attach without score collapse

- **WHEN** two outcomes attribute the same commit with different kinds
- **THEN** both SHALL project as distinct outcome nodes or edges
- **AND** lineage SHALL NOT require a single combined score field
