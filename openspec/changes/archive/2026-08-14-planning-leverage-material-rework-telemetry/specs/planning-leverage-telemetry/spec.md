## Purpose

Versioned planning-leverage telemetry that records phase boundaries, selected planning depth and risk class, duration metrics (elapsed vs known active effort), review effort, and fix-round counters as raw observations separate from derived metrics, so operators can later evaluate planning investment against correction cost without inventing a productivity score.

## ADDED Requirements

### Requirement: Versioned planning-leverage records SHALL represent phases, depth, risk, and effort without a collapsed score

The engine SHALL define planning-leverage telemetry with integer `record_schema_version` starting at `1`. Schema version `1` SHALL include at least:

- `record_schema_version` — integer, value `1` for this revision
- `type` — one of `planning_leverage_phase`, `planning_leverage_snapshot` (or the nested payload type name when embedded in a stream event)
- `run_id` — string identity of the pipeline run
- `issue` — integer issue number when known, else null
- `phase` — exactly one of `alignment`, `planning`, `implementation`, `review`, `correction` when the record is phase-scoped; null on whole-run snapshots when not phase-scoped
- `phase_instance_id` — stable string identity for a phase interval when phase-scoped, else null
- `planning_depth` — exactly one of `minimal`, `standard`, `deep`, `unknown`
- `risk_class` — string from the closed built-in risk-class vocabulary used by the engine (including `unknown` when not determined)
- `risk_classes` — optional array of additional risk-class strings from the same vocabulary
- duration fields per the duration-availability requirement
- `review_effort` — object with bounded integer counters (or nulls) for blocking findings, advisory findings, and re-review count, each with availability labeling as specified
- `fix_rounds` — non-negative integer count of fix rounds observed for the run or phase scope, or null when unavailable
- `attribution` — array of linkage entries (run/commit/pr/issue/component/production_outcome) when present
- `derived` — object namespace for derived metrics only (may be empty); SHALL NOT be the sole store of raw observations

The record SHALL NOT include a single overall leverage score, productivity score, expected-pain score, or equivalent collapsed numeric quality field. Readers SHALL ignore unknown fields for forward compatibility.

#### Scenario: schema version 1 carries required identity and classification fields

- **WHEN** a producer emits a planning-leverage phase or snapshot record with `record_schema_version: 1`
- **THEN** the object SHALL include `run_id`, `planning_depth`, `risk_class`, and the type identifier
- **AND** `planning_depth` SHALL be one of `minimal`, `standard`, `deep`, `unknown`
- **AND** `phase` SHALL be one of the closed phase values or null only when the record is not phase-scoped

#### Scenario: collapsed score field is forbidden

- **WHEN** a consumer validates a planning-leverage record or scoreboard section built for this capability
- **THEN** the schema contract SHALL NOT require or define `leverage_score`, `productivity_score`, or `expected_pain`
- **AND** tests SHALL assert those field names are absent from the emitted report object

#### Scenario: unknown fields are ignored by readers

- **WHEN** a record carries an unknown additive field under a supported `record_schema_version`
- **THEN** the reader SHALL ignore the unknown field and continue

---

### Requirement: Duration metrics SHALL derive from explicit timestamps and distinguish elapsed from active effort

For each phase interval, the engine SHALL record `started_at` and `ended_at` as ISO 8601 timestamps when known, else null. `elapsed_ms` SHALL be computed only when both timestamps are present as the non-negative difference in milliseconds; otherwise `elapsed_ms` SHALL be null and `elapsed_availability` SHALL be `unavailable`. The engine SHALL NOT invent start or end times.

Active effort SHALL be represented as an object `active_effort` with:

- `value_ms` — non-negative number or null
- `source` — one of `harness_accounted`, `operator_reported`, `derived`, `unknown`
- `availability` — one of `observed`, `inferred`, `unavailable`

When active effort is not known, `availability` SHALL be `unavailable`, `value_ms` SHALL be null, and the engine SHALL NOT copy `elapsed_ms` into `active_effort.value_ms` and SHALL NOT write `0` to mean unknown. Cost fields, when present, SHALL follow stage-cost-accounting semantics (`cost_source` of `actual` | `estimated` | `unknown` with `cost_usd` null when unknown).

#### Scenario: elapsed is computed only from both timestamps

- **WHEN** a phase interval has `started_at` and `ended_at` both set
- **THEN** `elapsed_ms` SHALL equal the millisecond difference between them
- **AND** `elapsed_availability` SHALL be `observed`

#### Scenario: missing end timestamp yields unavailable elapsed

- **WHEN** a phase interval has `started_at` set and `ended_at` null
- **THEN** `elapsed_ms` SHALL be null
- **AND** `elapsed_availability` SHALL be `unavailable`

#### Scenario: unknown active effort is not zero or elapsed

- **WHEN** a phase completes without known active-effort measurement
- **THEN** `active_effort.availability` SHALL be `unavailable`
- **AND** `active_effort.value_ms` SHALL be null
- **AND** `active_effort.value_ms` SHALL NOT equal `elapsed_ms` solely by defaulting
- **AND** `active_effort.value_ms` SHALL NOT be `0` used to mean unknown

#### Scenario: unknown cost remains null

- **WHEN** correction cost is not known from stage accounting or another observed source
- **THEN** any cost field on the planning-leverage record SHALL use `cost_source: "unknown"` and `cost_usd: null`
- **AND** SHALL NOT write `cost_usd: 0` to mean unknown

---

### Requirement: Selected planning depth and risk class SHALL be recorded as observed selection, not post-hoc quality judgment

The engine SHALL set `planning_depth` to the depth selected for the run by configuration, policy, or explicit operator choice at or before planning begins (or `unknown` when not determinable). The engine SHALL NOT set `planning_depth` by measuring plan file length, token counts, or subjective plan quality after the fact. Post-hoc judgments, when emitted at all, SHALL appear only under `derived` with `availability: "inferred"` and SHALL NOT overwrite the selected `planning_depth` field.

#### Scenario: configured depth is recorded as selected

- **WHEN** a run is configured or policy-selected to use `deep` planning depth
- **THEN** planning-leverage records for that run SHALL carry `planning_depth: "deep"`

#### Scenario: undetermined depth is unknown

- **WHEN** the engine cannot determine which planning depth was selected
- **THEN** `planning_depth` SHALL be `"unknown"`
- **AND** SHALL NOT default to `"standard"` without an actual selection

#### Scenario: inferred quality does not overwrite selection

- **WHEN** a derived metric estimates that the plan was thin relative to risk class
- **THEN** that estimate SHALL live under `derived` with inferred availability
- **AND** the selected `planning_depth` field SHALL remain unchanged

---

### Requirement: Raw observations SHALL be preserved separately from derived metrics

Raw phase timestamps, selected depth/risk, assumption statuses, fix-round counts, and materiality classifications SHALL be stored as first-class observed fields (or event payloads). Derived ratios, aggregates, and joins computed from those fields SHALL be written only under a `derived` object (on snapshots or reports) and SHALL each include enough metadata to identify their inputs and availability (`observed` | `inferred` | `unavailable`). Reporting consumers SHALL present derived values as derived, not as raw observations.

#### Scenario: snapshot separates raw and derived

- **WHEN** a planning-leverage snapshot includes both phase elapsed totals and a ratio of correction elapsed to planning elapsed
- **THEN** the phase elapsed totals SHALL appear as raw/observed fields (or an observed summary of raw phase events)
- **AND** the ratio SHALL appear under `derived` with availability set according to whether both inputs were observed

#### Scenario: unavailable input yields unavailable derived metric

- **WHEN** a derived ratio requires active correction effort and active effort is unavailable
- **THEN** the derived metric's availability SHALL be `unavailable`
- **AND** the engine SHALL NOT substitute elapsed wall time silently inside that derived metric without labeling the substitution as inferred

---

### Requirement: Planning-leverage free text and default storage SHALL honor privacy and host-local retention

Free-text fields on planning-leverage records SHALL pass write-time injection denylist and secret redaction before serialization. Payloads SHALL NOT contain raw prompts, model output, source code dumps, authentication tokens, or arbitrary environment secrets. Default durable storage SHALL be host-local under the repository `.agent-pipeline/` tree (run `events.jsonl` and optional per-run snapshot). Retention SHALL honor the configured run/evidence retention window; records outside the window SHALL be excluded from default scoreboard reports. Customer-hosted deployments SHALL be able to operate without shipping planning-leverage payloads to a third-party collector.

#### Scenario: secret in free text is redacted

- **WHEN** an assumption statement or resolution note contains a recognized secret pattern
- **THEN** the persisted record SHALL contain the redacted form
- **AND** the raw secret SHALL NOT appear on disk in the run store

#### Scenario: default path is host-local

- **WHEN** planning-leverage telemetry is emitted with default configuration
- **THEN** the durable event or snapshot SHALL be written under the repository `.agent-pipeline/` tree
- **AND** emission SHALL NOT require a fleet collector to succeed

#### Scenario: expired runs leave default reports

- **WHEN** a scoreboard window excludes a run by retention or time filter
- **THEN** that run's planning-leverage aggregates SHALL NOT appear in the default report totals for that window

---

### Requirement: Planning-leverage telemetry SHALL link to run identity and optional production outcomes without inventing ids

Each planning-leverage record SHALL be attributable to its `run_id` with `authority: "observed"` when emitted by the active run. The record MAY include attribution entries for issue, PR, commit, component, and `production_outcome` when evidence exists, using the same method/authority vocabulary as outcome-linkage. Producers SHALL NOT invent run ids, SHAs, PR numbers, or production-outcome ids to force a join. Missing links SHALL be omitted or recorded as diagnostics, not placeholder identities.

#### Scenario: run attribution is observed for the emitting run

- **WHEN** the pipeline emits a planning-leverage phase event for the active run
- **THEN** `run_id` SHALL equal the active run store identity
- **AND** any run attribution entry SHALL use `authority: "observed"`

#### Scenario: missing production outcome is not fabricated

- **WHEN** no production-outcome record yet exists for the run
- **THEN** the planning-leverage record SHALL omit `production_outcome` attribution
- **AND** SHALL NOT write a placeholder outcome id
