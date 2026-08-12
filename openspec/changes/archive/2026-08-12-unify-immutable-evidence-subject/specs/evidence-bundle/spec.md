## ADDED Requirements

### Requirement: Finalized evidence bundles SHALL expose evidence_subject mismatch diagnostics

When `finalizeRun` / `finalizeBundle` writes `summary.json` (and the legacy `evidence.json` mirror), the finalized bundle SHALL include a structured diagnostics collection for readiness-relevant artifacts that records subject comparison against the run’s evaluation pin subject (or the best-known pin at finalization). Each diagnostic entry SHALL include at least: artifact kind or reference, whether `evidence_subject` was present, comparison outcome (`match` | `mismatch` | `malformed` | `legacy_unbound`), and `mismatched_fields` (empty array on match or when not applicable). The bundle SHALL retain enough echoed subject field values that a dossier consumer can see which dimensions differed without recomputing digests from source trees. Project Warrant and other aggregators MUST NOT invent or repair subjects; they consume these diagnostics as written.

#### Scenario: finalize records match diagnostics for co-current evidence

- **WHEN** a run finalizes with review and tester artifacts whose subjects match the evaluation pin
- **THEN** `summary.json` SHALL contain diagnostic entries for those artifacts with outcome `match`
- **AND** `mismatched_fields` SHALL be empty for those entries

#### Scenario: finalize records field-level mismatch diagnostics

- **WHEN** a run finalizes with an artifact whose subject differs from the evaluation pin only on `policy_hash`
- **THEN** the diagnostic entry for that artifact SHALL have outcome `mismatch`
- **AND** `mismatched_fields` SHALL include `policy_hash`

#### Scenario: finalize labels legacy unbound artifacts

- **WHEN** a run finalizes with a historical readiness artifact that has no `evidence_subject`
- **THEN** the diagnostic entry SHALL have outcome `legacy_unbound`
- **AND** SHALL NOT report outcome `match`

#### Scenario: diagnostics do not require external recompute

- **WHEN** a dossier consumer reads the finalized diagnostics for a mismatched artifact
- **THEN** it SHALL be able to identify the mismatched field names from the diagnostic entry
- **AND** SHALL NOT need to re-hash policy, engine, or diff inputs to detect the mismatch when both subjects were recorded

---

### Requirement: Bundle review and override records SHALL carry evidence_subject when newly written

When the evidence bundle records a new `ReviewRecord` or a new override disposition that participates in readiness composition, the written record SHALL include a nested `evidence_subject` (or a pointer to the same subject object on the related review artifact) built from authoritative runtime state at record time. Existing review fields such as `sha` SHALL remain and SHALL stay consistent with `evidence_subject.candidate_sha` when the subject is present. Missing subjects on newly written readiness-relevant rows after this change SHALL be treated as producer defects (malformed/quarantine), not as silent matches.

#### Scenario: new review row in the bundle includes subject identity

- **WHEN** `recordReview()` records a review round into the in-memory bundle during a run that implements subject emission
- **THEN** the corresponding `ReviewRecord` SHALL carry `evidence_subject` with `schema_version: 1`
- **AND** `evidence_subject.candidate_sha` SHALL equal the recorded review `sha`

#### Scenario: new override row binds subject when readiness-relevant

- **WHEN** an override is applied and recorded into the bundle for readiness composition
- **THEN** the override record SHALL carry an `evidence_subject` (or explicit link to the bound review subject) derived from runtime state
- **AND** SHALL NOT rely on free-text override reason text as subject identity
