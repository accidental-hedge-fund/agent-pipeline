# evidence-subject Specification

## Purpose
Define the shared versioned `evidence_subject` contract so every readiness-relevant assurance artifact binds to the same immutable identity, and so consumers can compare subjects, invalidate stale evidence, and emit mismatch diagnostics without inventing family-specific identity schemes.
## Requirements
### Requirement: Versioned evidence_subject contract SHALL define a single shared identity shape

The pipeline SHALL define a versioned `evidence_subject` object with integer `schema_version` starting at `1`. Schema version `1` SHALL include at least:

- `schema_version` — integer, value `1` for this revision
- `domain` — repository domain identity string for the pipeline run
- `issue` — GitHub issue number
- `pr` — pull request number, or `null` when no PR exists
- `run_id` — pipeline run identifier
- `candidate_sha` — full 40-character hexadecimal commit SHA of the product candidate under evaluation
- `diff_hash` — canonical candidate/PR diff hash string used by review diff-hash caching, or `null` only when a diff is unavailable under the same rules that allow null review `diffHash`
- `policy_hash` — digest of the effective policy and configuration slice that governs readiness acceptance for the producing family
- `engine_fingerprint` — digest of the engine identity surface (engine version and template/engine pin material) used when the evidence was produced
- `verifier_fingerprint` — digest of the verifier or prompt surface for the producing family; when a family has no distinct verifier surface, this field SHALL still be present and MAY equal a documented derivation from the engine fingerprint
- `required_evidence_set_revision` — stable revision identifier or digest of the set of evidence kinds required for readiness at production time

Readers SHALL ignore unknown fields. The pipeline SHALL NOT invent a second parallel subject vocabulary for any single readiness family that renames or conflicts with these fields. A run identifier alone SHALL NOT be treated as a complete evidence subject.

#### Scenario: schema_version 1 object carries the required field set

- **WHEN** a producer emits an `evidence_subject` with `schema_version: 1`
- **THEN** the object SHALL include `domain`, `issue`, `pr`, `run_id`, `candidate_sha`, `diff_hash`, `policy_hash`, `engine_fingerprint`, `verifier_fingerprint`, and `required_evidence_set_revision`
- **AND** `candidate_sha` SHALL be a full 40-character hex SHA when the candidate is known

#### Scenario: run_id alone is not a complete subject

- **WHEN** a consumer is asked whether two evidence records share readiness identity
- **THEN** equality of `run_id` alone SHALL NOT be sufficient to declare a subject match
- **AND** the consumer SHALL require the versioned subject comparison (or an explicit legacy disposition) before treating multi-family evidence as co-current

#### Scenario: family-specific identity names do not replace the shared shape

- **WHEN** Tester, review, correction, or bundle records attach subject identity
- **THEN** they SHALL use the shared `evidence_subject` field set
- **AND** SHALL NOT require a family-only subject id type that conflicts with these field names

---

### Requirement: Producers SHALL derive evidence_subject from authoritative runtime state

Deterministic engine code SHALL build each `evidence_subject` from authoritative runtime inputs: resolved repository/domain identity, issue and PR numbers, active `run_id`, candidate HEAD SHA pin, computed canonical diff hash, effective policy/config digest inputs, engine identity, verifier/prompt surface identity, and the required-evidence-set revision in force at production time. The pipeline SHALL NOT accept harness prose, reviewer free text, or model-authored JSON as the source of subject fields. When a required non-nullable field cannot be resolved, the producer SHALL fail production of that readiness artifact or mark the subject unusable under the malformed disposition — it SHALL NOT invent placeholder identity values that look like a match.

#### Scenario: engine-built subject does not trust writer prose

- **WHEN** an implementer or reviewer harness claims a candidate SHA or policy identity in free text
- **THEN** the producer SHALL ignore that prose for `evidence_subject` fields
- **AND** SHALL populate the subject only from engine-resolved runtime state

#### Scenario: missing candidate SHA fails closed for readiness production

- **WHEN** a readiness-relevant producer cannot resolve a full 40-character candidate SHA
- **THEN** it SHALL NOT emit a well-formed subject that claims a fabricated SHA
- **AND** consumers SHALL treat any resulting missing or malformed subject as non-authoritative for readiness pass

---

### Requirement: Canonicalization and comparison SHALL be deterministic

The pipeline SHALL provide deterministic canonicalization and comparison for `evidence_subject` values. Canonicalization SHALL use a stable field order, normalize SHA and digest hex to lowercase, represent absent nullable fields as JSON `null` (not omitted when comparing v1 required keys), and exclude wall-clock timestamps from the subject object. Comparison of two subjects (an artifact subject against an evaluation pin subject) SHALL return a structured result that distinguishes at least:

- `match` — all compared v1 identity dimensions equal under canonicalization
- `mismatch` — well-formed subjects that differ in one or more fields, with the list of mismatched field names
- `malformed` — missing required structure, wrong types, or unsupported/unreadable `schema_version` under hard-refuse rules
- `legacy_unbound` — artifact lacks a subject under the transitional legacy rule

Comparison SHALL be pure with respect to its inputs (no network, git, or filesystem required for the compare function itself).

#### Scenario: identical logical subjects compare as match

- **WHEN** two subjects are built from the same logical field values with only hex case differences
- **THEN** comparison SHALL return `match`
- **AND** `mismatched_fields` SHALL be empty

#### Scenario: candidate SHA difference is a candidate mismatch

- **WHEN** two well-formed subjects differ only in `candidate_sha`
- **THEN** comparison SHALL return `mismatch`
- **AND** `mismatched_fields` SHALL include `candidate_sha`

#### Scenario: policy hash difference is a policy mismatch

- **WHEN** two well-formed subjects differ only in `policy_hash`
- **THEN** comparison SHALL return `mismatch`
- **AND** `mismatched_fields` SHALL include `policy_hash`

#### Scenario: verifier fingerprint difference is a verifier mismatch

- **WHEN** two well-formed subjects differ only in `verifier_fingerprint`
- **THEN** comparison SHALL return `mismatch`
- **AND** `mismatched_fields` SHALL include `verifier_fingerprint`

#### Scenario: diff hash difference is a diff mismatch

- **WHEN** two well-formed subjects differ only in `diff_hash`
- **THEN** comparison SHALL return `mismatch`
- **AND** `mismatched_fields` SHALL include `diff_hash`

#### Scenario: malformed subject is not a match

- **WHEN** an artifact’s subject is missing required v1 fields or has invalid types
- **THEN** comparison SHALL return `malformed`
- **AND** SHALL NOT return `match`

---

### Requirement: Invalidation rules SHALL map dimension changes to non-current evidence

When an evaluation pin’s subject is compared to stored evidence, the pipeline SHALL apply these invalidation rules for readiness currency:

1. **Candidate change** — mismatch on `candidate_sha` (for a product candidate move) renders prior readiness evidence non-current for the new candidate; affected families MUST regenerate or re-acquire evidence for the new candidate before it can contribute a readiness pass.
2. **Diff change** — mismatch on `diff_hash` renders diff-bound review reuse and any evidence that claims that exact diff non-current.
3. **Policy change** — mismatch on `policy_hash` renders policy-bound acceptance and readiness composition that depends on that policy slice non-current; families whose recorded facts do not claim that policy slice MAY remain current for those facts only when candidate/diff/engine/verifier dimensions still match under family rules.
4. **Engine or verifier change** — mismatch on `engine_fingerprint` or `verifier_fingerprint` renders evidence that claims verification under the prior surface non-current for families that depend on that surface.
5. **Required-evidence-set change** — mismatch on `required_evidence_set_revision` renders readiness composition non-current even if individual family artifacts still match on candidate identity; newly required kinds must be present and subject-matched before readiness pass.

A change only to `run_id` without other dimension changes SHALL NOT by itself invent a readiness pass for unmatched candidate/policy/verifier dimensions. After any candidate-changing fix that advances product HEAD, earlier evidence bound to the prior candidate subject SHALL be non-current until regeneration.

#### Scenario: post-fix new candidate invalidates prior evidence

- **WHEN** readiness evidence was produced for candidate SHA A
- **AND** a fix advances the product candidate to SHA B where A ≠ B
- **THEN** comparison against the new evaluation pin SHALL report mismatch on `candidate_sha`
- **AND** consumers SHALL NOT treat the A-bound evidence as current readiness pass for B
- **AND** regeneration for B SHALL be required before that family can contribute a pass for B

#### Scenario: policy-only change does not rewrite candidate SHA identity

- **WHEN** two subjects share `candidate_sha` and `diff_hash` but differ in `policy_hash`
- **THEN** comparison SHALL mismatch on `policy_hash`
- **AND** policy-bound readiness acceptance SHALL be non-current
- **AND** the candidate identity fields SHALL remain equal in the diagnostic

#### Scenario: required-evidence-set revision blocks composition

- **WHEN** family artifacts match the evaluation pin on candidate and verifier dimensions
- **AND** `required_evidence_set_revision` on the composition pin differs from the revision recorded when composition last succeeded
- **THEN** readiness composition SHALL be non-current
- **AND** diagnostics SHALL name `required_evidence_set_revision`

---

### Requirement: Consumers SHALL reject or quarantine missing, malformed, or mismatched subjects

Readiness consumers SHALL classify each artifact’s subject against the evaluation pin before treating the artifact as current. On `malformed`, the consumer SHALL quarantine the artifact and SHALL NOT use it as pass or fail authority for the live pin. On `mismatch` for dimensions that govern that family’s currency, the consumer SHALL treat the artifact as non-current (stale) and require regeneration or re-acquisition. On `match`, family-local outcome rules apply. Consumers SHALL emit structured diagnostics naming the outcome and mismatched fields when non-match occurs.

#### Scenario: mismatched subject is non-current

- **WHEN** a consumer loads readiness evidence whose subject mismatches the evaluation pin on `candidate_sha`
- **THEN** it SHALL classify the evidence as non-current for the pin
- **AND** SHALL NOT present it as a readiness pass for the pin

#### Scenario: malformed subject is quarantined

- **WHEN** a consumer loads an artifact with a present but malformed `evidence_subject`
- **THEN** it SHALL quarantine the artifact
- **AND** SHALL NOT treat it as either pass or fail authority for the live pin solely from that artifact

---

### Requirement: Legacy artifacts without a subject SHALL use an explicit unbound disposition

When a historical readiness artifact predates subject emission and carries no `evidence_subject`, consumers SHALL classify it as `legacy_unbound` rather than as an implicit full subject match. During the transitional period, a consumer MAY fall back to existing field-level checks (for example `candidate_sha` or `reviewedSha`) for that family, but diagnostics MUST label the evidence `legacy_unbound` and MUST NOT claim multi-dimension subject match. A future schema or policy revision MAY hard-refuse `legacy_unbound` for readiness; until then, silent upgrade of unbound artifacts to full match is forbidden. Unsupported future `schema_version` values SHALL be treated as `malformed` or hard-refused, never as match.

#### Scenario: pre-subject artifact is legacy_unbound

- **WHEN** a consumer loads a well-formed historical Tester or review artifact with no `evidence_subject` field
- **THEN** subject comparison SHALL return `legacy_unbound`
- **AND** diagnostics SHALL mark the artifact as legacy unbound
- **AND** the consumer SHALL NOT report a full subject `match`

#### Scenario: unsupported schema_version is not a match

- **WHEN** an artifact carries `evidence_subject.schema_version` greater than the highest version the running engine understands
- **THEN** comparison SHALL return `malformed` or hard-refuse
- **AND** SHALL NOT return `match`

---

### Requirement: Mismatch diagnostics SHALL be suitable for external dossier consumers without recomputation

When the pipeline exposes subject comparison results on an evidence bundle or readiness composition surface, the diagnostic record for each artifact SHALL include at least: artifact reference or kind, whether a subject was present, comparison outcome, and `mismatched_fields` (empty on match). When both the evaluation pin subject and the artifact subject are present and well-formed, an external consumer (including Project Warrant) SHALL be able to detect staleness from those fields without recomputing policy, engine, or diff hashes from source trees. Project Warrant and other aggregators MUST NOT invent or repair a missing subject; only Agent Pipeline producers create authoritative subjects.

#### Scenario: diagnostic names mismatched fields without re-hash

- **WHEN** an evidence bundle records a subject mismatch on `policy_hash` between pin and artifact
- **THEN** the diagnostic entry SHALL include outcome `mismatch` and `mismatched_fields` containing `policy_hash`
- **AND** a dossier consumer SHALL NOT need to recompute the policy digest to see that the subjects differ

#### Scenario: external consumer must not invent subjects

- **WHEN** an artifact has no subject and is classified `legacy_unbound`
- **THEN** a dossier aggregator SHALL retain that disposition
- **AND** SHALL NOT synthesize a synthetic full subject that claims match

### Requirement: verifier_fingerprint SHALL bind to the trusted-surface effective verifier identity when present

When a run has a computed trusted-surface decision with a resolved `effective_verifier_hash`, readiness producers that emit `evidence_subject` SHALL set `verifier_fingerprint` to that hash or to a documented pure derivation that includes that hash plus any family-local verifier slice. The producer SHALL NOT populate `verifier_fingerprint` from candidate-only weakened verifier material when the decision rebound or blocked the candidate’s sensitive paths. When the decision outcome is `blocked` and no trustworthy effective verifier pin exists, the producer SHALL fail closed for readiness subject production (malformed / unusable subject) rather than invent a matching fingerprint from the candidate surface.

Family-local material (for example Tester toolchain identity) MAY still refine the fingerprint after the trusted-surface hash is included, provided the derivation is pure, documented, and changes when either the trusted surface or the family-local slice changes.

#### Scenario: passthrough and rebound subjects use effective verifier hash

- **WHEN** a trusted-surface decision exists with `outcome` `passthrough` or `rebound` and non-empty `effective_verifier_hash` H
- **AND** a readiness producer builds `evidence_subject` for that run and candidate
- **THEN** `verifier_fingerprint` SHALL equal H or a documented pure derivation that includes H
- **AND** SHALL NOT equal a hash of the candidate-weakened surface alone when rebound bound judging to the trusted pin

#### Scenario: blocked decision does not invent a trustworthy verifier fingerprint

- **WHEN** the trusted-surface decision `outcome` is `blocked` and no trustworthy effective verifier pin is available
- **THEN** the producer SHALL NOT emit a well-formed subject that claims a fabricated `verifier_fingerprint` match for readiness pass
- **AND** consumers SHALL treat missing or unusable subjects under existing malformed / non-current rules

#### Scenario: family-local refinement still tracks trusted surface change

- **WHEN** two subjects share family-local verifier inputs
- **AND** their trusted-surface `effective_verifier_hash` values differ
- **THEN** their `verifier_fingerprint` values SHALL differ
- **AND** comparison SHALL report a verifier mismatch

