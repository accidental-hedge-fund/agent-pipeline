## ADDED Requirements

### Requirement: New review artifacts SHALL carry a nested evidence_subject

When the pipeline posts a new review comment (round 1, round 2, or delta re-review) and embeds a `ReviewArtifact` block, the artifact JSON SHALL include a nested `evidence_subject` conforming to the shared `evidence-subject` contract (`schema_version` starting at `1`). The subject SHALL be built by deterministic engine code from the runtime evaluation pin at review time (domain, issue, PR, run id when known, reviewed candidate SHA, canonical diff hash, effective review policy hash, engine and verifier/prompt fingerprints, required-evidence-set revision). Existing fields `reviewedSha` and `diffHash` SHALL remain for backward compatibility and SHALL equal `evidence_subject.candidate_sha` and `evidence_subject.diff_hash` respectively when the subject is present (`diffHash` / `diff_hash` both null when the diff is unavailable under existing rules). Model-authored review body text SHALL NOT supply subject fields.

#### Scenario: new review artifact includes evidence_subject

- **WHEN** the pipeline posts a review comment for any review round with a `ReviewArtifact` block
- **THEN** decoding the artifact SHALL yield an `evidence_subject` object with `schema_version: 1`
- **AND** `evidence_subject.candidate_sha` SHALL equal `reviewedSha`
- **AND** when a PR diff was available, `evidence_subject.diff_hash` SHALL equal `diffHash`

#### Scenario: subject is engine-authored not reviewer prose

- **WHEN** the reviewer model outputs free text that claims a different commit SHA
- **THEN** the footer `ReviewArtifact.evidence_subject` SHALL still use the engine-resolved reviewed HEAD SHA
- **AND** SHALL NOT copy the free-text claim into the subject

#### Scenario: legacy comments without subject remain extractable

- **WHEN** a gate reads a pre-migration review comment whose `ReviewArtifact` lacks `evidence_subject` or that has only individual sentinels
- **THEN** `extractReviewArtifact` behavior for existing fields SHALL remain available
- **AND** subject comparison SHALL classify the artifact as `legacy_unbound` when no subject is present

---

### Requirement: Gates that compose multi-family readiness SHALL prefer evidence_subject comparison

When a gate or readiness consumer needs multi-dimension identity (not only SHA or only diff hash), it SHALL read `evidence_subject` from the review artifact when present and apply the shared comparison semantics against the evaluation pin. Field-level fallbacks (`reviewedSha`, `diffHash`, individual sentinels) remain valid for family-local SHA and diff-hash checks and for `legacy_unbound` artifacts. A subject `mismatch` on candidate or diff SHALL NOT be treated as a full multi-family readiness match even if a single legacy sentinel happens to equal one pin field.

#### Scenario: subject mismatch blocks treating review as co-current with other evidence

- **WHEN** a readiness consumer compares a review artifact subject to the evaluation pin
- **AND** comparison returns `mismatch` on `candidate_sha` or `diff_hash`
- **THEN** the consumer SHALL treat that review evidence as non-current for multi-family readiness composition
- **AND** SHALL NOT claim subject match solely because a short SHA in comment prose matches

#### Scenario: matching subject allows existing verdict routing rules

- **WHEN** a review artifact’s `evidence_subject` matches the evaluation pin
- **THEN** existing SHA-gate, diff-hash cache, and blocking-keys rules MAY apply as today for that review
- **AND** residual blocking keys on a matched subject still hold under existing review-sha-gating rules
