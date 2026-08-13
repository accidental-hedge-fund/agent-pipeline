## ADDED Requirements

### Requirement: Pre-code attestation and dossier evidence SHALL bind shared evidence_subject identity

Pre-code attestation records and design-dossier revisions that participate in readiness or gate currency SHALL attach or reference the shared `evidence_subject` contract (or a documented binding to its policy and run identity dimensions). The effective attestation-policy configuration hash SHALL contribute to `policy_hash` (or an explicitly documented attestation-policy digest that invalidates on policy change under the same comparison rules). The pipeline SHALL NOT invent a second subject vocabulary solely for pre-code attestation.

#### Scenario: attestation policy change mismatches policy dimension

- **WHEN** an attestation record was produced under attestation policy hash P1
- **AND** the evaluation pin's subject or policy dimension reflects policy hash P2
- **THEN** comparison or invalidation rules SHALL treat the prior attestation as non-current for gate clearance

#### Scenario: no competing subject type

- **WHEN** producers emit identity for pre-code attestation or dossier artifacts
- **THEN** they SHALL use the shared `evidence_subject` field set (or nested binding documented against it)
- **AND** SHALL NOT require a family-only subject id type that conflicts with shared field names

#### Scenario: dossier revision currency is explicit

- **WHEN** a dossier content hash changes after an approve
- **THEN** prior attestation bound to the previous dossier revision SHALL be non-current
- **AND** consumers SHALL NOT treat run_id equality alone as sufficient currency
)
