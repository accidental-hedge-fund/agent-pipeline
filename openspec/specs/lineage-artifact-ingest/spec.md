# lineage-artifact-ingest Specification

## Purpose
Defines deterministic projection of repository-native and pipeline-produced artifacts into the intent-lineage graph so identities stay sourced from authoritative systems rather than free-form agent rewrites.

## Requirements

### Requirement: Ingest SHALL project from authoritative artifact sources without inventing identities

Lineage ingest SHALL project nodes and edges from durable authoritative sources when present, including at least:

- issue metadata and acceptance criteria / intent statements
- OpenSpec requirements, scenarios, and change specs (path + revision identity)
- approved pre-code dossier objectives (`objective_id` + content hash)
- pipeline runs (`run_id`, domain, issue, PR when known)
- commits and pull requests (full SHA, PR number)
- verification evidence references (tests, evals, shipcheck)
- production outcome records and their attribution entries
- consequential decision records (`answered` / `deferred` / `open`)
- policy and override lifecycle events that affect acceptance (#693 / #695 class inputs)

When a source field is absent, ingest SHALL omit the node/edge or mark link state `missing`/`unknown` with diagnostics. Ingest SHALL NOT invent run ids, SHAs, objective ids, or outcome ids to force completeness.

#### Scenario: objective projection uses dossier identity

- **WHEN** an approved dossier lists `objective_id` O with content hash H
- **THEN** ingest SHALL create or upsert an `objective` node whose identity material includes O and H
- **AND** SHALL NOT allocate a different random id for the same O+H pair

#### Scenario: missing run id is not fabricated

- **WHEN** a verification ref is known but no `run_id` is resolvable
- **THEN** ingest SHALL leave the run endpoint absent or `unknown`
- **AND** SHALL NOT write a placeholder run id

#### Scenario: OpenSpec path revision is projected as requirement identity

- **WHEN** a requirement is sourced from `openspec/specs/foo/spec.md` at a known content hash
- **THEN** the `requirement` node SHALL carry that path and content hash as identity material under the repository domain

---

### Requirement: Ingest methods and authority SHALL be recorded on every written edge

Each ingested edge SHALL set `provenance.method` to a closed value that includes at least `direct`, `trailer`, `adapter`, `manual`, and `heuristic`, and SHALL set `provenance.authority` to `observed` or `inferred` under the same authority rules used by outcome-linkage: trailer/direct store joins are `observed`; temporal co-occurrence or free-text similarity alone is `inferred`.

#### Scenario: Pipeline-Run trailer join is observed

- **WHEN** a commit message carries `Pipeline-Run: 599/2026-08-14T02:58:43Z` and a matching run node exists
- **THEN** the commit→run edge SHALL use method `trailer` or `direct`
- **AND** authority SHALL be `observed`

#### Scenario: title similarity alone is inferred

- **WHEN** the only join between an issue and a PR is free-text title similarity
- **THEN** any edge written from that join SHALL have authority `inferred`
- **AND** SHALL NOT be labeled `observed`

---

### Requirement: Objective manifest projection SHALL reuse the lineage graph without a second planning artifact

Ingest SHALL project the compact run objective manifest defined by pre-code design dossier rules into lineage `objective` nodes and verification-mapping edges. The engine SHALL NOT create a second planning state machine or a parallel manifest store format solely for lineage.

#### Scenario: objective manifest maps to verification edges

- **WHEN** an approved objective has final verification evidence
- **THEN** ingest SHALL emit a `verifies` or `maps_evidence` edge from the objective node to the verification node
- **AND** SHALL NOT require a separate planning stage label to hold that mapping

#### Scenario: no second planning SM

- **WHEN** lineage ingest runs for a triggered dossier
- **THEN** it SHALL use existing plan/dossier/evidence artifacts as sources
- **AND** SHALL NOT introduce additional pipeline stage labels solely for objective planning

---

### Requirement: Production outcomes SHALL project into lineage while preserving multi-target attribution

When a production outcome record is ingested, the engine SHALL create a `production_outcome` node and edges for each attribution target that has evidence, preserving many-to-many targets and observed-vs-inferred authority. Multiple outcomes MAY attach to one run or commit without collapsing into one score.

#### Scenario: multi-target outcome edges

- **WHEN** an outcome attributes a run, a commit SHA, and a component
- **THEN** lineage SHALL include edges (or equivalent multi-target links) for each
- **AND** SHALL NOT force a single primary target

#### Scenario: disputed outcome remains disputed in lineage

- **WHEN** outcome observation_state is `disputed`
- **THEN** projected edges SHALL carry `link_state: "disputed"` or equivalent dispute markers
- **AND** prior claims SHALL remain visible

---

### Requirement: Policy and override lifecycle events SHALL participate as invalidation inputs

Ingest SHALL project policy lifecycle and governed override events as `policy_event` / `override_event` nodes (or typed edges `affected_by_policy` / `invalidates`) so impact analysis can mark dependent acceptance edges stale when policy or override identity changes.

#### Scenario: policy event invalidates dependent mapped evidence

- **WHEN** a policy lifecycle event changes the effective policy hash for a run's acceptance surface
- **THEN** ingest SHALL record a policy_event node or invalidation edge
- **AND** dependent `maps_evidence` edges MAY be marked `stale` with a stable reason code such as `policy_event_invalidated`

#### Scenario: override event is visible without granting new product authority

- **WHEN** a governed override is recorded for a finding
- **THEN** lineage MAY include an `override_event` node linked to the run or finding identity
- **AND** that node SHALL NOT authorize silent upstream requirement mutation

---

### Requirement: Ingest SHALL be offline-testable with fixtures and non-fatal on partial sources

Unit tests SHALL drive ingest with fixture artifacts and injected filesystem/run-store deps only (no live network or real git). Partial source availability SHALL produce partial graphs with diagnostics rather than throwing unhandled exceptions for ordinary missing fields.

#### Scenario: fixture end-to-end chain ingests

- **WHEN** fixtures supply intent, requirement, objective, run, commit, verification, and production outcome artifacts
- **THEN** ingest SHALL produce a connected graph covering that chain
- **AND** integrity validation SHALL pass for present endpoints

#### Scenario: missing optional outcome store does not crash

- **WHEN** run and objective sources exist but the outcome store is empty
- **THEN** ingest SHALL complete for available nodes
- **AND** SHALL emit diagnostics for absent outcome links rather than failing hard by default
