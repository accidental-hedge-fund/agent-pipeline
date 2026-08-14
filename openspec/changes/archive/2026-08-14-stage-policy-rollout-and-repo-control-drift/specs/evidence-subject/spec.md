## ADDED Requirements

### Requirement: Staged policy promotion or retirement SHALL recompute policy_hash inputs for the acceptance slice

When a staged policy transition changes the effective acceptance-relevant configuration (including promotion into `enforcing` or retirement from an accepting state), producers of `evidence_subject` SHALL use the post-transition policy slice when computing `policy_hash`. The pipeline SHALL NOT retain the pre-transition `policy_hash` on new readiness artifacts as if the acceptance slice were unchanged. Comparison against an evaluation pin that uses the new hash SHALL report a `policy_hash` mismatch for artifacts still carrying the prior hash, rendering them non-current for policy-bound readiness under the existing invalidation matrix.

#### Scenario: Post-promotion subject uses new policy_hash

- **WHEN** a policy transitions into `enforcing` and the acceptance slice changes
- **AND** a new readiness artifact is produced after the transition
- **THEN** that artifact’s `evidence_subject.policy_hash` SHALL equal the post-transition policy hash
- **AND** SHALL NOT equal the pre-transition policy hash when those hashes differ

#### Scenario: Pre-transition evidence is non-current after policy_hash change

- **WHEN** readiness evidence was produced under `policy_hash` H1
- **AND** a staged policy transition yields evaluation pin `policy_hash` H2 where H2 ≠ H1
- **THEN** subject comparison SHALL return `mismatch` with `mismatched_fields` including `policy_hash`
- **AND** consumers SHALL treat that evidence as non-current for policy-bound readiness

#### Scenario: No competing subject vocabulary for policy lifecycle

- **WHEN** staged policy identity is attached to readiness or drift artifacts
- **THEN** producers SHALL continue to use the shared `evidence_subject` field set for readiness identity
- **AND** SHALL NOT invent a parallel subject type that renames or replaces `policy_hash`
