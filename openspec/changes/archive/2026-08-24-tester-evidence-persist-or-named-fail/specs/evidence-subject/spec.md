## MODIFIED Requirements

### Requirement: verifier_fingerprint SHALL bind to the trusted-surface effective verifier identity when present

When a run has a computed trusted-surface decision with a resolved `effective_verifier_hash`, readiness producers that emit `evidence_subject` SHALL set `verifier_fingerprint` to that hash or to a documented pure derivation that includes that hash plus any family-local verifier slice. The producer SHALL NOT populate `verifier_fingerprint` from candidate-only weakened verifier material when the decision rebound or blocked the candidate’s sensitive paths. When the decision outcome is `blocked` and no trustworthy effective verifier pin exists, the producer SHALL fail closed for readiness subject production (malformed / unusable subject) rather than invent a matching fingerprint from the candidate surface.

Family-local material (for example Tester toolchain identity) MAY still refine the fingerprint after the trusted-surface hash is included, provided the derivation is pure, documented, and changes when either the trusted surface or the family-local slice changes.

Fail-closed readiness subject production SHALL NOT suppress the Tester family artifact after a successful suite command. The pipeline SHALL still persist SHA-matched `tester-evidence.json` (without a fabricated subject) or fail review with a named persist/acquire reason per `tester-evidence`.

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

#### Scenario: blocked subject does not suppress Tester family artifact after successful suite command

- **WHEN** the trusted-surface decision `outcome` is `blocked` and no trustworthy effective verifier pin is available
- **AND** the Tester producer recorded a required test-gate command exit 0
- **AND** a run directory is available
- **THEN** the producer SHALL NOT omit `tester-evidence.json` solely because subject emission failed closed
- **AND** the written suite record, if present, SHALL omit a fabricated readiness subject rather than claim verifier-fingerprint match
