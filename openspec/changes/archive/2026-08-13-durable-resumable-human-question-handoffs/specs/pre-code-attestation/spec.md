## ADDED Requirements

### Requirement: Non-authority handoff answers SHALL NOT satisfy pre-code attestation approval

A human-question handoff answer with `authority_mode: non_authority`, or any handoff that is not an explicit attestation decision under the pre-code attestation record schema, SHALL NOT clear a triggered pre-code attestation gate. Authority-bearing handoffs MAY reuse the same authenticated identity source and authorized-approver resolution patterns as pre-code attestation, but a handoff answer SHALL satisfy implementing-entry only when it is recorded as a current, valid attestation approve (or the existing attestation record path succeeds independently). Context, expertise, and manual-repair answers remain distinct from attestation.

#### Scenario: Context handoff answer does not enter implementing on a triggered gate

- **WHEN** the pre-code attestation gate is triggered and no current approve attestation exists
- **AND** an operator answers a non-authority `missing_context` handoff on the same issue
- **THEN** the issue SHALL NOT enter `implementing` solely because of that handoff answer
- **AND** the attestation gate SHALL remain in effect

#### Scenario: Authority resolution patterns may be shared without merging schemas

- **WHEN** an authority-bearing handoff resolves eligible responders using identity, group_ref, role, or path_owner rules
- **THEN** that resolution MAY share pure helper patterns with pre-code attestation approver resolution
- **AND** a successful handoff answer SHALL still NOT be treated as a pre-code attestation approve unless an attestation record is separately validated
