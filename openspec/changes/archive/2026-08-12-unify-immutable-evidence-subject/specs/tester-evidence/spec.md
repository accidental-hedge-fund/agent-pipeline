## ADDED Requirements

### Requirement: Tester evidence producers SHALL emit a nested evidence_subject from runtime state

When the deterministic Tester producer writes a `TesterEvidence` record for a suite run, it SHALL populate a nested `evidence_subject` object conforming to the shared `evidence-subject` contract (`schema_version` starting at `1`). Subject fields SHALL be derived from authoritative runtime state available to the producer (candidate HEAD SHA, run id, issue, PR, domain, effective test/gate config material folded into policy or config digests as documented, engine identity, verifier/toolchain surface, required-evidence-set revision). Top-level `candidate_sha`, `run_id`, `issue`, and `pr` SHALL remain and SHALL equal the corresponding subject fields when both are present. The producer SHALL NOT leave `evidence_subject` absent on newly produced schema-current records, and SHALL NOT accept model or harness prose as subject input.

#### Scenario: successful suite production includes evidence_subject

- **WHEN** the deterministic tester producer completes a trusted suite run for candidate SHA S on run R for issue N
- **THEN** the written `TesterEvidence` record SHALL include `evidence_subject` with `schema_version: 1`
- **AND** `evidence_subject.candidate_sha` SHALL equal top-level `candidate_sha` and the full 40-character value of S
- **AND** `evidence_subject.run_id` SHALL equal the active run id R
- **AND** `evidence_subject.issue` SHALL equal N

#### Scenario: top-level identity stays consistent with subject

- **WHEN** a `TesterEvidence` record is serialized with both top-level identity fields and `evidence_subject`
- **THEN** `candidate_sha`, `run_id`, `issue`, and `pr` SHALL equal the corresponding subject fields
- **AND** the record SHALL NOT introduce a Tester-only subject type that renames those concepts

---

### Requirement: Tester acquisition SHALL validate evidence_subject currency before treating suite evidence as current

Acquisition and pre-merge consumers of `TesterEvidence` SHALL compare the artifact’s `evidence_subject` to the evaluation pin subject (or, when building a pin, at least the live candidate SHA and other dimensions required for suite currency) using the shared comparison semantics. On subject `mismatch` for candidate (or other dimensions that govern suite currency), the evidence SHALL be classified stale/non-current. On `malformed`, the evidence SHALL be quarantined and SHALL NOT supply pass or fail authority. On `legacy_unbound` (historical records without a subject), acquisition MAY fall back to existing `candidate_sha` match rules but MUST label the result legacy unbound and MUST NOT claim full multi-dimension subject match. A subject match does not invent a suite pass: family-local `overall_status` rules still apply.

#### Scenario: subject candidate mismatch is stale

- **WHEN** acquisition loads Tester evidence whose `evidence_subject.candidate_sha` is A
- **AND** the evaluation pin candidate SHA is B where A ≠ B
- **THEN** acquisition SHALL classify the evidence as non-current for B
- **AND** SHALL NOT present it as a suite pass for B

#### Scenario: exact subject match allows family-local status rules

- **WHEN** acquisition loads well-formed Tester evidence whose `evidence_subject` matches the evaluation pin
- **AND** `overall_status` is `"passed"`
- **THEN** acquisition MAY treat the suite result as current for that pin under existing pass rules
- **AND** SHALL NOT ignore a non-pass `overall_status` solely because the subject matches

#### Scenario: legacy artifact without subject uses candidate_sha fallback with legacy label

- **WHEN** acquisition loads a historical `TesterEvidence` record that has no `evidence_subject`
- **AND** top-level `candidate_sha` equals the evaluation pin candidate SHA
- **THEN** acquisition MAY treat candidate identity as matching under the legacy path
- **AND** diagnostics SHALL mark the evidence `legacy_unbound`
- **AND** SHALL NOT report a full subject `match`

#### Scenario: post-fix regeneration required after candidate change

- **WHEN** Tester evidence exists for candidate A and a fix advances the product candidate to B
- **THEN** the A-bound evidence SHALL be non-current for B under subject comparison
- **AND** the deterministic producer MUST regenerate evidence for B before suite pass authority applies to B
