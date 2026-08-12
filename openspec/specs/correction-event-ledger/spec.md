# correction-event-ledger Specification

## Purpose
TBD - created by archiving change correction-event-ledger. Update Purpose after archive.
## Requirements
### Requirement: The engine SHALL define an append-only correction_event contract

The engine SHALL define a `correction_event` record type appended to the run's append-only
event stream to record an *observable* accepted operator correction or recovered failure. Each
`correction_event` SHALL carry, in addition to the base `schema_version`, `type`, and `at`
fields: a stable `correction_id` (string), a deterministic `correction_key` (string), a
`source_kind`, a `failure_class`, an `actor_kind`, `issue` (integer), `repo` (string), `run_id`
(string), `stage` (stage name string or null), `reviewed_sha` (string or null), `head_sha`
(string or null), an `evidence_ref` object, a `correction` string, a `reusable` value, and an
optional `proposed_control`. `source_kind` SHALL be one of `override`, `rejection`, `retry`,
`repair`, `unblock`, `manual`. `reusable` SHALL be one of `yes`, `no`, `unknown`.
`proposed_control`, when present, SHALL be one of `instruction`, `skill-rubric`, `eval`,
`deterministic-gate`, `human-judgment`. All fields are additive, so `schema_version` SHALL
remain `1`.

#### Scenario: a correction_event carries the full contract

- **WHEN** a `correction_event` is appended for an accepted correction
- **THEN** it SHALL contain `schema_version`, `type: "correction_event"`, `at`, `correction_id`, `correction_key`, `source_kind`, `failure_class`, `actor_kind`, `issue`, `repo`, `run_id`, `stage`, `evidence_ref`, `correction`, and `reusable`
- **AND** `reviewed_sha` and `head_sha` SHALL be present (string) when a reviewed/head SHA applies to the correction and `null` otherwise
- **AND** `proposed_control` SHALL be present only when a control is proposed

#### Scenario: bounded fields reject out-of-enum values

- **WHEN** a `correction_event` is constructed
- **THEN** `source_kind` SHALL be one of `override`, `rejection`, `retry`, `repair`, `unblock`, `manual`
- **AND** `reusable` SHALL be one of `yes`, `no`, `unknown`
- **AND** `actor_kind` SHALL be one of `human`, `pipeline`

### Requirement: source_kind SHALL determine actor_kind

The engine SHALL derive `actor_kind` from `source_kind`, never from inferred identity or
prose. Operator-driven surfaces (`override`, `rejection`, `unblock`, `manual`) SHALL record
`actor_kind: "human"`; autonomous-recovery surfaces (`retry`, `repair`) SHALL record
`actor_kind: "pipeline"`. The event SHALL NOT carry a human username, email, or other personal
identifier.

#### Scenario: operator surface records a human actor

- **WHEN** a `correction_event` is emitted for an `override`, `rejection`, `unblock`, or `manual` correction
- **THEN** `actor_kind` SHALL be `"human"`

#### Scenario: recovery surface records a pipeline actor

- **WHEN** a `correction_event` is emitted for a `retry` or `repair` correction
- **THEN** `actor_kind` SHALL be `"pipeline"`

#### Scenario: no personal identity is leaked

- **WHEN** any `correction_event` is emitted
- **THEN** it SHALL NOT contain a human username, email address, or other personal identifier beyond the bounded `actor_kind`

### Requirement: correction_key SHALL be deterministic from bounded fields only

The engine SHALL derive `correction_key` as a pure deterministic function of the bounded
fields `source_kind`, `failure_class`, and `stage` only. The derivation SHALL NOT read raw
free text, the issue number, the PR number, any SHA, or any model-generated paraphrase. Two
corrections that agree on `source_kind`, `failure_class`, and `stage` SHALL produce the same
`correction_key`, so a downstream consumer can match recurrence deterministically. The engine
SHALL define a single derivation helper and SHALL NOT reimplement the key elsewhere.

#### Scenario: same bounded fields yield the same key

- **WHEN** two corrections have identical `source_kind`, `failure_class`, and `stage`
- **THEN** their `correction_key` SHALL be equal
- **AND** the equality SHALL hold even when their issue number, PR number, SHA, and `correction` text differ

#### Scenario: key ignores unbounded inputs

- **WHEN** two corrections agree on `source_kind`, `failure_class`, and `stage` but differ in issue number, PR number, reviewed/head SHA, or `correction` free text
- **THEN** their `correction_key` SHALL still be equal

#### Scenario: differing bounded fields yield different keys

- **WHEN** two corrections differ in `source_kind`, `failure_class`, or `stage`
- **THEN** their `correction_key` SHALL differ

### Requirement: failure_class SHALL be a closed enum with an escape hatch

The engine SHALL define `failure_class` as a closed string union whose members are
`review-finding`, `blocker`, `harness-crash`, `test-build-failure`, `eval-shipcheck-failure`,
`merge-conflict`, `spec-defect`, `env-tooling`, and `other`. `other` SHALL be the escape hatch
used when no known class applies; the emitter SHALL never throw or omit `failure_class`.
Consumers SHALL treat any unrecognized `failure_class` string as `other` for aggregation while
preserving the raw string. Adding a member SHALL NOT bump `schema_version`; removing or
renaming a member SHALL be a breaking change requiring a `schema_version` bump.

#### Scenario: unknown class falls back to other

- **WHEN** a correction cannot be mapped to a known `failure_class`
- **THEN** the emitter SHALL set `failure_class: "other"` rather than throwing or omitting it
- **AND** the resulting event SHALL be valid and appended

#### Scenario: consumer tolerates an unrecognized class string

- **WHEN** a consumer reads a `correction_event` whose `failure_class` is not in its known set
- **THEN** it SHALL count the event under `other` for aggregation
- **AND** it SHALL preserve the original `failure_class` string in the raw record

### Requirement: A correction_event SHALL preserve evidence lineage and SHA staleness

Each `correction_event` SHALL carry an `evidence_ref` object with a bounded `kind` (one of
`finding`, `blocker`, `event`, `comment`, `artifact`) and an `id` string identifying the
originating evidence (e.g. a `findingKey`, a blocker kind/message, an event or comment id, or
an artifact path). When the correction concerns reviewed code, the event SHALL carry
`reviewed_sha` (the SHA the corrected evidence was reviewed against) and `head_sha` (the
current head SHA when the correction was recorded), so a consumer can distinguish a stale
correction from a current one using only the run directory. A finding-derived `evidence_ref.id`
SHALL be the `findingKey` from `review-policy.ts`, never a reimplemented identity.

#### Scenario: evidence_ref points at the originating finding

- **WHEN** a `correction_event` is emitted for an overridden or rejected review finding
- **THEN** `evidence_ref.kind` SHALL be `"finding"`
- **AND** `evidence_ref.id` SHALL equal the finding's `findingKey` from `review-policy.ts`

#### Scenario: stale correction is distinguishable from a current one

- **WHEN** a consumer reads a `correction_event` whose `reviewed_sha` differs from the run's current head SHA
- **THEN** the consumer SHALL be able to classify the correction as stale using only the run directory, with no GitHub access
- **AND** a `correction_event` whose `reviewed_sha` equals the current head SHALL be classifiable as current

### Requirement: The engine SHALL emit a correction_event only after a corrective action is durably accepted

The engine SHALL append exactly one `correction_event` from each Pipeline-owned corrective
surface — `override`, `unblock`, `retry`/recovery, `rejection`, and `repair` — only after the
action is durably accepted. A failed or no-op command SHALL append no `correction_event`. A
bare blocker, a raw review finding, or a retry *attempt* SHALL NOT be recorded as a correction;
the event SHALL represent an accepted action or disposition, not a detection.

#### Scenario: durably-accepted override emits one event

- **WHEN** an operator `--override` is durably applied to a finding and recorded
- **THEN** exactly one `correction_event` SHALL be appended with `source_kind: "override"` and `actor_kind: "human"`
- **AND** its `evidence_ref` SHALL point at the overridden finding's `key`

#### Scenario: successful unblock emits one event

- **WHEN** an unblock posts its answer AND the blocked label is cleared
- **THEN** exactly one `correction_event` SHALL be appended with `source_kind: "unblock"`

#### Scenario: successful recovery emits one event

- **WHEN** an auto-recovery attempt durably succeeds
- **THEN** exactly one `correction_event` SHALL be appended with `source_kind: "retry"` and `actor_kind: "pipeline"`

#### Scenario: durably-landed repair emits one event

- **WHEN** a fix commit lands AND the targeted blocker/finding is cleared on re-check
- **THEN** exactly one `correction_event` SHALL be appended with `source_kind: "repair"` and `actor_kind: "pipeline"`

#### Scenario: failed or no-op command emits nothing

- **WHEN** an override matches no finding, an unblock fails to clear the label, or a retry/fix attempt does not resolve its target
- **THEN** no `correction_event` SHALL be appended

#### Scenario: a detection is not a correction

- **WHEN** a `blocker_set` event is appended, or a review round enumerates a finding, or a retry is merely attempted
- **THEN** no `correction_event` SHALL be appended for that detection alone

### Requirement: correction_id SHALL be stable so replay is idempotent

The engine SHALL derive a `correction_id` that is unique per correction instance yet
reproducible when the same correction is emitted again (e.g. after a crash-and-retry), so that
downstream consumers deduping by `correction_id` collapse duplicate deliveries or replays to a
single logical correction. The record content, excluding the append-time `at`, SHALL be
identical across replays of the same correction.

#### Scenario: replay of the same correction shares a correction_id

- **WHEN** the same accepted correction is emitted twice (e.g. a re-run after a crash)
- **THEN** both `correction_event` records SHALL carry the same `correction_id`
- **AND** a consumer deduping by `correction_id` SHALL treat them as one correction

#### Scenario: distinct corrections carry distinct ids

- **WHEN** two different accepted corrections are emitted in the same run
- **THEN** their `correction_id` values SHALL differ

### Requirement: correction_event free text SHALL be screened and the write SHALL be non-fatal

The engine SHALL screen the `correction` and `evidence_ref.id` free-text fields through the
existing write-time injection denylist and secret redaction before serialization: a span
matching the injection denylist SHALL be replaced with `[REDACTED-INJECTION]` and a secret
value SHALL be replaced with `[REDACTED]`, with the record still written (not dropped). The
`correction` text SHALL be bounded (capped) rather than unbounded. Appending a `correction_event`
SHALL be non-fatal: a write failure SHALL be caught and logged as a warning and SHALL NOT
abort, block, or change any stage outcome, and no label, blocking, or routing decision SHALL
read the ledger.

#### Scenario: injection span in correction text is redacted

- **WHEN** a `correction` field contains a span matching an injection-denylist pattern
- **THEN** the persisted record SHALL contain `[REDACTED-INJECTION]` in place of that span
- **AND** the record SHALL still be appended

#### Scenario: secret in a correction field is redacted before serialization

- **WHEN** a `correction` or `evidence_ref.id` field contains a quoted env-secret assignment like `OPENAI_API_KEY="<value>"`
- **THEN** the persisted record SHALL contain `[REDACTED]` in place of the value
- **AND** the raw secret value SHALL NOT appear even though JSON escaping surrounds the quotes

#### Scenario: write failure does not affect the run

- **WHEN** appending a `correction_event` throws an I/O error
- **THEN** the surrounding stage or command SHALL continue to its normal outcome
- **AND** a warning SHALL be logged

### Requirement: Reports SHALL surface malformed or older correction records visibly without breaking the run

A consumer or report that reads `correction_event` records SHALL validate `schema_version` and
the required bounded fields. A malformed record or one whose `schema_version` is unknown SHALL
be surfaced as a visible error in the report rather than silently dropped, but SHALL NOT crash
the reader or abort the run. Existing run artifacts SHALL remain readable: a run with no
`correction_event` records SHALL read normally.

#### Scenario: malformed correction record is surfaced, not fatal

- **WHEN** a report reads a `correction_event` that is malformed or carries an unknown `schema_version`
- **THEN** the report SHALL surface the record as a visible error
- **AND** the reader SHALL continue and the run SHALL NOT be aborted

#### Scenario: run without correction events reads normally

- **WHEN** a report reads a run directory that contains no `correction_event` records
- **THEN** it SHALL read the run normally with no error

### Requirement: correction_event records SHALL bind an evidence_subject or an explicit unbound disposition

When the engine appends a new `correction_event` for an accepted operator correction or recovered failure, the event SHALL include either:

- a nested `evidence_subject` conforming to the shared `evidence-subject` contract (`schema_version` starting at `1`), built from authoritative runtime state at emission time (resolved domain/repo, issue, PR, run id, reviewed/head candidate SHA, and digest fields — never a caller-supplied subject object as identity authority), or
- an explicit `evidence_subject: null` when the emission path cannot resolve a full subject under documented constraints — never omit the field on a newly written event, and never an implicit claim of full multi-dimension match.

`evidence_subject: null` on a current-schema write is a producer unbound disposition. Consumers SHALL quarantine it (non-current; no full subject match) and SHALL NOT route it through the historical `legacy_unbound` reviewed_sha fallback. Only pre-migration records that omit `evidence_subject` entirely are `legacy_unbound`.

When `reviewed_sha` and `head_sha` are present as strings, and `evidence_subject` is a present object, `evidence_subject.candidate_sha` SHALL equal the candidate those SHA fields represent for that event (typically the reviewed or head SHA applicable to the correction). Staleness consumers SHALL prefer subject comparison when a subject object is present; bare `reviewed_sha` ≠ current head remains a valid legacy signal and MUST agree with subject candidate mismatch when both are present.

#### Scenario: new correction_event carries evidence_subject

- **WHEN** a `correction_event` is emitted for an accepted override with a known candidate SHA S on run R and the digest inputs required to build a subject
- **THEN** the event SHALL contain `evidence_subject` with `schema_version: 1`
- **AND** `evidence_subject.candidate_sha` SHALL equal S
- **AND** `evidence_subject.run_id` SHALL equal R

#### Scenario: new correction_event writes explicit null when subject cannot be resolved

- **WHEN** a `correction_event` is emitted and required subject inputs (candidate SHA and/or digests) cannot form a full subject
- **THEN** the written event SHALL include `evidence_subject: null`
- **AND** SHALL NOT omit the `evidence_subject` key
- **AND** a currency consumer SHALL quarantine the event (non-current)
- **AND** SHALL NOT classify it as `legacy_unbound`

#### Scenario: emitter does not trust a caller-supplied subject object

- **WHEN** emission receives runtime digests and reviewed/head SHAs that resolve candidate S
- **THEN** the written `evidence_subject.candidate_sha` SHALL equal S derived from those event SHA fields
- **AND** the emitter SHALL NOT accept an arbitrary nested subject object as authoritative identity in place of that runtime derivation

#### Scenario: subject candidate mismatch aligns with stale SHA lineage

- **WHEN** a correction_event’s `evidence_subject.candidate_sha` is A
- **AND** the run’s current evaluation pin candidate is B where A ≠ B
- **THEN** subject comparison SHALL report mismatch on `candidate_sha`
- **AND** consumers SHALL classify the correction lineage as stale for B the same way a `reviewed_sha` ≠ head check does today
- **AND** SHALL NOT treat the event as current for B solely because `run_id` matches

#### Scenario: non-candidate subject mismatch is non-current for correction readiness

- **WHEN** a correction_event’s `evidence_subject` matches the evaluation pin on `candidate_sha`
- **AND** comparison mismatches on any of `policy_hash`, `engine_fingerprint`, `verifier_fingerprint`, or `required_evidence_set_revision`
- **THEN** the currency consumer SHALL report `subject_outcome: mismatch` with those fields in `mismatched_fields`
- **AND** SHALL classify the event as non-current (`stale: true`) for readiness reuse
- **AND** SHALL NOT treat candidate-only freshness as event currentness

#### Scenario: historical events without subject are legacy_unbound

- **WHEN** a consumer reads a pre-migration `correction_event` that has `reviewed_sha` / `head_sha` but no `evidence_subject` key
- **THEN** subject comparison SHALL return `legacy_unbound`
- **AND** SHALL NOT claim a full subject match

#### Scenario: legacy_unbound with evaluation pin is non-current for readiness

- **WHEN** a consumer classifies a pre-migration `correction_event` that omits `evidence_subject`
- **AND** a well-formed evaluation pin subject is available
- **THEN** the consumer SHALL treat the event as non-current for readiness composition
- **AND** SHALL label the outcome `legacy_unbound`
- **AND** SHALL NOT certify currency from `reviewed_sha` matching the pin candidate alone

#### Scenario: legacy SHA-only fallback when pin unavailable

- **WHEN** a consumer classifies a pre-migration `correction_event` that omits `evidence_subject`
- **AND** no evaluation pin subject is available
- **THEN** the consumer MAY apply reviewed_sha vs candidate SHA staleness rules for non-readiness lineage
- **AND** SHALL still label the outcome `legacy_unbound`
- **AND** SHALL NOT claim a full multi-dimension subject match

