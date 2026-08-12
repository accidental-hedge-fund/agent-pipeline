## ADDED Requirements

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
