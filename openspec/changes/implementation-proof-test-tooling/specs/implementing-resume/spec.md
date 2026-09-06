## MODIFIED Requirements

### Requirement: Planning and implementation deliverables SHALL have distinct identities

The pipeline SHALL record or derive a verifiable role and identity for the accepted planning artifact and a separate identity for the implementation candidate. Implementing-stage goal checks SHALL accept only implementation-role evidence bound to the current Candidate epoch. A content match, commit authorship marker, or OpenSpec change path SHALL NOT change a planning artifact into implementation evidence. Candidate-bound source code, tests, fixtures, examples, mocks, executable scripts, and tooling SHALL be eligible implementation artifacts; their directory names SHALL NOT by themselves demote the candidate to unknown or planning-only. Unknown non-code configuration SHALL remain fail-closed unless another authoritative product-artifact rule identifies it.

#### Scenario: Salvage preserves planning role

- **WHEN** recovery salvages a commit whose material product delta is only the planning artifact
- **THEN** the salvaged commit SHALL remain classified as planning provenance
- **AND** SHALL NOT satisfy the implementing-stage goal

#### Scenario: Candidate replacement requires new implementation proof

- **WHEN** implementation was proved for candidate epoch `E1`
- **AND** the candidate moves to epoch `E2`
- **THEN** the prior implementation proof SHALL be invalid for `E2`
- **AND** post-implementation work SHALL wait until the implementation postcondition is re-proved for `E2`

#### Scenario: Test-only candidate is implementation evidence

- **WHEN** an exact current candidate changes only candidate-bound test, fixture, example, or mock code
- **THEN** the implement-deliverable observer SHALL classify the candidate as implementation-role evidence
- **AND** implementing-stage recovery SHALL NOT re-invoke the implementer solely because those artifacts live under test-oriented paths

#### Scenario: Tooling-only candidate is implementation evidence

- **WHEN** an exact current candidate changes only candidate-bound executable scripts or tooling code
- **THEN** the implement-deliverable observer SHALL classify the candidate as implementation-role evidence
- **AND** the candidate SHALL remain subject to the normal post-implementation gates

#### Scenario: Planning and unknown configuration remain fail closed

- **WHEN** an exact current candidate contains only OpenSpec, documentation, workflow, or unknown non-code configuration artifacts
- **THEN** those artifacts SHALL NOT qualify as implementation-role evidence under the test-and-tooling rule
- **AND** existing planning-only or unknown fail-closed behavior SHALL remain in force
