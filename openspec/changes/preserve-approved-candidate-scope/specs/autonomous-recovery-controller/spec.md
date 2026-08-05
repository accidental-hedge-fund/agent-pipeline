## ADDED Requirements

### Requirement: Mechanical repair SHALL run the candidate-integrity protocol around head movement

The recovery path SHALL capture a pre-mutation candidate-integrity manifest, perform the repair transaction, capture a post-mutation manifest from the authoritative head/base, and classify the transition under the `candidate-integrity` capability whenever `repair_pipeline_item` (or equivalent recovery mechanical remediation) is about to move the authoritative candidate head. Classification SHALL use `mutation_method` of `recovery_repair` (or the method name assigned by that capability for recovery). Classification and disposition SHALL follow that capability: scope expansion and unverified comparison invalidate prior review and readiness and re-enter scoped review or bounded recovery; they MUST NOT silently authorize ready-to-deploy and MUST NOT invent a human-authority hold solely for the mechanical integrity class.

#### Scenario: Recovery repair captures before and after manifests

- **WHEN** recovery claims a mechanical repair that will commit and push a new candidate head
- **THEN** a pre-mutation candidate-integrity manifest SHALL be durable before the head-moving side effect
- **AND** after a successful push the path SHALL classify the before/after transition and emit a `candidate_integrity` event

#### Scenario: Recovery repair scope expansion does not skip whole-item gates

- **WHEN** recovery repair classifies as `scope_expansion`
- **THEN** the item SHALL re-enter normal whole-item execution against the new head with review and readiness evidence invalidated
- **AND** SHALL NOT become ready-to-deploy until candidate-integrity and normal gates pass on a later accepted head

#### Scenario: Recovery preserves authority boundaries under integrity failure

- **WHEN** integrity classification is `unverified` or `scope_expansion` after a recovery repair attempt
- **THEN** the controller SHALL NOT merge, override, weaken review policy, or create a human hold solely for that integrity class
- **AND** SHALL leave structured integrity diagnostics in durable evidence
