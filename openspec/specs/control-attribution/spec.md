# control-attribution Specification

## Purpose
TBD - created by archiving change closed-loop-control-attribution. Update Purpose after archive.
## Requirements
### Requirement: The engine SHALL define a durable control_attribution record linking a correction class to a control

The engine SHALL define a `control_attribution` record that durably links a `correction_key`
(the deterministic recurrence key from the correction ledger) to the control that resolved it.
Each record SHALL carry `schema_version`, `type: "control_attribution"`, an append-time `at`, a
stable `attribution_id`, the `correction_key`, a `control_type`, a `disposition`, `issue`
(integer or null), `pr` (integer or null), `effective_commit` (string or null),
`effective_release` (string or null), `effective_at` (ISO string or null), `supersedes`
(`attribution_id` string or null), an `evidence_ref` object, and a bounded `note`. `control_type`
SHALL be one of `instruction`, `skill-rubric`, `eval`, `deterministic-gate`, or `human-judgment`,
reusing the correction ledger's control vocabulary. `disposition` SHALL be one of `implemented`,
`human-owned`, `rejected`, or `superseded`. `effective_at` SHALL be a non-null timestamp only when
the disposition ships an effective control (`implemented`, or a `superseded` record that itself
carries a replacement control) and SHALL be `null` otherwise.

#### Scenario: an attribution carries the full contract

- **WHEN** a `control_attribution` is recorded for a resolved control proposal
- **THEN** it SHALL contain `schema_version`, `type: "control_attribution"`, `at`, `attribution_id`, `correction_key`, `control_type`, `disposition`, `issue`, `pr`, `effective_commit`, `effective_release`, `effective_at`, `supersedes`, `evidence_ref`, and `note`

#### Scenario: bounded fields reject out-of-enum values

- **WHEN** a `control_attribution` is constructed
- **THEN** `control_type` SHALL be one of `instruction`, `skill-rubric`, `eval`, `deterministic-gate`, or `human-judgment`
- **AND** `disposition` SHALL be one of `implemented`, `human-owned`, `rejected`, or `superseded`

#### Scenario: only an effective control sets a recurrence boundary

- **WHEN** a `control_attribution` is recorded with `disposition: "human-owned"` or `disposition: "rejected"`
- **THEN** `effective_at` SHALL be `null`
- **AND** when the disposition is `implemented`, `effective_at` SHALL be a non-null timestamp

### Requirement: A control_attribution SHALL be written only by an explicit audited command

The engine SHALL write a `control_attribution` only through an explicit, authority-bounded
command (`pipeline correction attribute`) that appends exactly one sanitized record. That command
SHALL mutate no GitHub state and SHALL NOT require gh authentication. No state-machine stage, no
`pre_merge`, `deploy_ready`, or merge path, and no issue-close or PR-merge event SHALL write a
`control_attribution` or otherwise mark a control effective. Attribution is an explicit maintainer
claim, never inferred from repository activity.

#### Scenario: closing an issue writes no attribution

- **WHEN** the control-proposal issue is closed or an arbitrary PR referencing it is merged
- **THEN** no `control_attribution` record SHALL be written
- **AND** no control SHALL be marked effective as a side effect of that close or merge

#### Scenario: the explicit command records one attribution

- **WHEN** `pipeline correction attribute` is invoked with a `correction_key`, `control_type`, and `disposition`
- **THEN** exactly one sanitized `control_attribution` record SHALL be appended to the durable attribution store
- **AND** the command SHALL invoke no GitHub-mutating operation

### Requirement: attribution_id SHALL be stable so replay is idempotent

The engine SHALL derive `attribution_id` as a pure function of the attribution's identifying
fields, so that re-recording the same attribution (for example after a crash-and-retry) produces
the same `attribution_id` and a consumer deduping by `attribution_id` collapses the duplicates to
one logical attribution. Two attributions that differ in an identifying field SHALL produce
different `attribution_id`s.

#### Scenario: re-recording the same attribution shares an id

- **WHEN** the same attribution is recorded twice
- **THEN** both records SHALL carry the same `attribution_id`
- **AND** a consumer deduping by `attribution_id` SHALL treat them as one attribution

#### Scenario: distinct attributions carry distinct ids

- **WHEN** two attributions differ in `correction_key`, `control_type`, or the resolved control's identity
- **THEN** their `attribution_id` values SHALL differ

### Requirement: control_attribution free text SHALL be screened and the write SHALL be non-fatal

The engine SHALL screen the `note` and `evidence_ref.id` free-text fields through the existing
write-time injection denylist and secret redaction before serialization: a span matching the
injection denylist SHALL be replaced with `[REDACTED-INJECTION]` and a secret value SHALL be
replaced with `[REDACTED]`, with the record still written. The `note` text SHALL be bounded rather
than unbounded. Appending a `control_attribution` SHALL be non-fatal: a write failure SHALL be
caught and logged as a warning and SHALL NOT abort or change any command's outcome.

#### Scenario: secret in a note is redacted before serialization

- **WHEN** a `note` or `evidence_ref.id` field contains a value matching a recognized secret pattern
- **THEN** the persisted record SHALL contain the redacted form
- **AND** the raw secret value SHALL NOT appear in the record

#### Scenario: write failure does not affect the command

- **WHEN** appending a `control_attribution` throws an I/O error
- **THEN** the surrounding command SHALL continue to its normal outcome
- **AND** a warning SHALL be logged

### Requirement: A consumer SHALL tolerate malformed, old-schema, and orphan attributions

A consumer that reads `control_attribution` records SHALL validate `schema_version` and the
required bounded fields. A malformed record, one whose `schema_version` is unknown, or one whose
`correction_key` matches no observed correction class SHALL be surfaced as a visible diagnostic
rather than silently dropped, and SHALL NOT crash the reader. A missing attribution store SHALL be
a valid empty state, not an error.

#### Scenario: malformed attribution is surfaced, not fatal

- **WHEN** a consumer reads a `control_attribution` that is malformed or carries an unknown `schema_version`
- **THEN** the consumer SHALL surface it as a visible diagnostic
- **AND** the reader SHALL continue without crashing

#### Scenario: orphan attribution is diagnosed

- **WHEN** a `control_attribution` names a `correction_key` that no observed `correction_event` carries
- **THEN** the consumer SHALL surface it as a diagnostic
- **AND** it SHALL NOT crash or fabricate a matching correction class

#### Scenario: missing attribution store reads as empty

- **WHEN** a consumer reads a repository that has no attribution store
- **THEN** it SHALL read zero attributions with no error

