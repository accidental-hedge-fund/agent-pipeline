## ADDED Requirements

### Requirement: Rebound Tester evidence SHALL emit a well-formed evidence_subject after same-SHA trusted-surface passthrough or rebound

When Tester evidence for candidate SHA S omitted `evidence_subject` because trusted-surface was not yet candidate-observable, and a later decision for the same SHA S is `passthrough` or `rebound` with a trustworthy `effective_verifier_hash`, the bind or reproduce path SHALL emit a well-formed nested `evidence_subject` on the SHA-matched Tester record. `evidence_subject.candidate_sha` SHALL equal the final pushed PR head S. `verifier_fingerprint` SHALL bind to the trusted-surface effective verifier identity. The producer SHALL NOT invent a subject while trusted-surface remains `blocked` or lacks a trustworthy verifier pin.

#### Scenario: same-SHA passthrough fills the omitted subject

- **WHEN** Tester evidence for SHA S has no `evidence_subject`
- **AND** trusted-surface for S later resolves `passthrough` or `rebound` with non-empty `effective_verifier_hash` H
- **THEN** the rebound or reproduced Tester record for S SHALL include `evidence_subject` with `schema_version: 1`
- **AND** `evidence_subject.candidate_sha` SHALL equal S
- **AND** `verifier_fingerprint` SHALL equal H or a documented pure derivation that includes H

#### Scenario: blocked trusted-surface still omits a fabricated subject

- **WHEN** Tester evidence for SHA S has no `evidence_subject`
- **AND** trusted-surface for S remains `blocked` with no trustworthy effective verifier pin
- **THEN** the pipeline SHALL NOT write a well-formed `evidence_subject` that claims a fabricated verifier-fingerprint match
- **AND** readiness consumers SHALL still treat that omitted subject as unusable for a readiness pass
