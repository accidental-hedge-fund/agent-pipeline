# production-outcome-records Specification

## Purpose
TBD - created by archiving change production-outcome-linkage. Update Purpose after archive.

## Requirements

### Requirement: Versioned production-outcome records SHALL represent concrete multi-kind outcomes without a collapsed score

The engine SHALL define a durable `production_outcome` record with integer `schema_version` starting at `1`. Schema version `1` SHALL include at least:

- `schema_version` — integer, value `1` for this revision
- `type` — constant `"production_outcome"`
- `outcome_id` — stable string identity for idempotent ingest
- `outcome_kind` — exactly one of `delivery`, `reversion`, `escaped_defect`, `follow_up_rework`, `change_amplification`, `post_control_recurrence`
- `observation_state` — exactly one of `observed`, `delayed`, `unknown`, `not_observed`, `disputed`
- `observed_at` — ISO 8601 timestamp when the signal was observed by an adapter or operator, or null when not yet observed
- `signal_at` — ISO 8601 timestamp of the underlying production/rework event when known, else null
- `source` — object identifying adapter id and raw signal reference (no secrets)
- `delivery` — delivery-chain object (required for `outcome_kind: "delivery"`; optional/null for other kinds when not applicable)
- `summary` — bounded redacted human-readable summary
- `evidence_refs` — array of bounded evidence references (urls, run paths, attribution ids) without embedded secrets

The record SHALL NOT include a single overall maintainability score, badness score, or equivalent collapsed numeric quality field. Readers SHALL ignore unknown fields for forward compatibility.

#### Scenario: schema_version 1 carries required identity and kind fields

- **WHEN** a producer emits a `production_outcome` with `schema_version: 1`
- **THEN** the object SHALL include `type: "production_outcome"`, `outcome_id`, `outcome_kind`, `observation_state`, `observed_at`, `signal_at`, `source`, `delivery` (object or null), `summary`, and `evidence_refs`
- **AND** `outcome_kind` SHALL be one of the closed enum values listed above

#### Scenario: collapsed score field is forbidden

- **WHEN** a consumer validates a `production_outcome` record
- **THEN** the schema contract SHALL NOT require or define an overall score field that replaces per-kind records
- **AND** tests SHALL assert that scoreboard/reporting paths built for this capability do not emit a single `maintainability_score` derived solely from outcome kinds

#### Scenario: unknown fields are ignored by readers

- **WHEN** a record carries an unknown additive field under a supported `schema_version`
- **THEN** the reader SHALL ignore the unknown field and continue

---

### Requirement: Delivery-chain fields SHALL record environment, status, candidate SHA, verification, and rollback with explicit unknown states

For `outcome_kind: "delivery"`, the `delivery` object SHALL include:

- `environment` — string or null
- `deploy_status` — one of `succeeded`, `failed`, `rolled_back`, `in_progress`, `unknown`, `not_observed`
- `deployed_candidate_sha` — full 40-character lowercase hex SHA when known, else null
- `merge_status` — one of `merged`, `not_merged`, `unknown`, `not_observed`
- `merged_sha` — full 40-character hex SHA when known, else null
- `verification` — object with `status` (`passed` | `failed` | `unknown` | `not_observed`), `evidence_ref` (string or null), `fresh_at` (ISO 8601 or null)
- `rollback` — object with `occurred` (boolean or null), `outcome` (`succeeded` | `failed` | `unknown` | `not_observed` | null)

Ready-to-deploy pipeline final state alone SHALL NOT authorize `deploy_status: "succeeded"` or `merge_status: "merged"`. Missing signals SHALL use `unknown` or `not_observed` rather than inventing success.

#### Scenario: delivery record carries full chain fields

- **WHEN** a `delivery` outcome is recorded from a complete adapter signal
- **THEN** `delivery` SHALL include `environment`, `deploy_status`, `deployed_candidate_sha`, `merge_status`, `merged_sha`, `verification`, and `rollback`

#### Scenario: ready-to-deploy alone is not production success

- **WHEN** a run has `finalState` ready-to-deploy and no merge or deployment signal is present
- **THEN** no `production_outcome` of kind `delivery` SHALL be written with `deploy_status: "succeeded"` solely from that final state
- **AND** a consumer MAY record or imply `not_observed` for merge and deploy without claiming success

#### Scenario: absent deploy signal is not silent success

- **WHEN** merge evidence exists but no deployment environment signal is available
- **THEN** `deploy_status` SHALL be `not_observed` or `unknown`
- **AND** SHALL NOT default to `succeeded`

#### Scenario: rollback outcome is explicit

- **WHEN** an adapter observes a rollback of a deployed candidate
- **THEN** `delivery.rollback.occurred` SHALL be `true` when known
- **AND** `delivery.rollback.outcome` SHALL be one of the allowed values (not omitted as if no rollback policy exists)

---

### Requirement: Delayed and not-yet-observed outcomes SHALL be representable without fabricating facts

A `production_outcome` MAY be stored with `observation_state: "delayed"` when a signal is expected but not yet available, or with `observation_state: "not_observed"` / `"unknown"` when a query found no evidence. Producers SHALL NOT convert delayed or unknown states into `observed` success or failure without new evidence. When evidence later arrives, a new or superseding record (same `outcome_id` replace/upsert under documented idempotent rules, or a linked supersession id) SHALL update the observation rather than silently mutating unrelated runs.

#### Scenario: delayed outcome is stored

- **WHEN** an operator or adapter records that deployment verification is still pending for a known candidate
- **THEN** a record MAY exist with `observation_state: "delayed"`
- **AND** `deploy_status` MAY be `in_progress` or `not_observed` without claiming final success

#### Scenario: later evidence updates without inventing a different candidate

- **WHEN** a delayed delivery observation later receives a deployment success signal for the same stable `outcome_id` inputs
- **THEN** the stored record SHALL update to `observation_state: "observed"` with the new delivery fields
- **AND** SHALL NOT change `deployed_candidate_sha` to a different SHA without a new outcome identity or explicit supersession

---

### Requirement: Outcome free text SHALL be redacted and the default store SHALL be host-local with retention

Free-text fields (`summary`, evidence free-text, notes) SHALL pass write-time injection denylist and secret redaction before serialization. Outcome payloads SHALL NOT contain raw prompts, model output, source code dumps, authentication tokens, or arbitrary environment secrets. The default durable store SHALL be host-local under the repository `.agent-pipeline/` tree (path documented as `.agent-pipeline/outcomes/` or equivalent). Retention SHALL be configurable; records older than the retention window SHALL be excluded from default reports or expired according to documented policy. Customer-hosted deployments SHALL be able to operate without shipping outcome payloads to a third-party collector.

#### Scenario: secret in summary is redacted

- **WHEN** a summary or note contains a value matching a recognized secret pattern
- **THEN** the persisted record SHALL contain the redacted form
- **AND** the raw secret SHALL NOT appear on disk in the outcome store

#### Scenario: default store is under .agent-pipeline

- **WHEN** an outcome is ingested with default configuration
- **THEN** the durable file SHALL be written under the repository `.agent-pipeline/` outcomes path
- **AND** ingest SHALL NOT require a fleet collector to succeed

#### Scenario: expired records leave default reports

- **WHEN** retention is configured to N days and a record’s relevant timestamp is older than N days
- **THEN** default outcome listing/scoreboard windows that honor retention SHALL exclude that record
- **AND** exclusion SHALL be testable without live network

### Requirement: Production-outcome attribution SHALL consume logical_operation_id when present

When a `production_outcome` record attributes to a pipeline run that stores `logical_operation_id`, the attribution SHALL include that identifier (or an attribution target that names it) rather than treating GitHub labels or comment prose as unique-operation success. Readers SHALL ignore the additive field when absent. Outcome ingest SHALL NOT invent a logical identity and SHALL NOT reclassify labels into a parallel reliability success rate.

#### Scenario: Observed run attribution carries the logical identity

- **WHEN** an adapter records a `delivery` outcome attributed to a run whose `run.json` contains `logical_operation_id` `L`
- **THEN** the stored attribution SHALL name `L` or the run that persists `L`
- **AND** SHALL NOT claim unique-operation verified completion from a `pipeline:ready-to-deploy` label alone

#### Scenario: Historical outcomes without logical identity remain valid

- **WHEN** a `production_outcome` attributes to a historical run that has no `logical_operation_id`
- **THEN** the record SHALL remain valid
- **AND** unique-operation scoreboard consumption SHALL treat that linkage as missing correlation rather than inferred success
