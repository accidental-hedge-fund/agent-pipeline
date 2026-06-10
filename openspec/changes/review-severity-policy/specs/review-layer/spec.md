## MODIFIED Requirements

### Requirement: Two review rounds with verdict-driven routing
Review SHALL run as two rounds — `review-1` (standard) then `review-2` (adversarial). An `approve`
verdict advances (`review-1`→`review-2`, `review-2`→`pre-merge`). A `needs-attention` verdict's
findings SHALL be evaluated against the repo's `review_policy` (severity threshold, confidence floor)
and any active operator overrides: when at least one finding **blocks**, the issue routes to the
matching fix stage (`review-1`→`fix-1`, `review-2`→`fix-2`) on the blocking subset; when no finding
blocks (all advisory or overridden), the issue advances as if approved with an audited record. Under the
default policy every finding blocks, so routing is unchanged from prior behavior. (The policy and
override semantics are specified by `review-severity-policy`.)

#### Scenario: round 1 approves
- **WHEN** `review-1` returns `approve`
- **THEN** the issue SHALL advance to `review-2`

#### Scenario: round 2 needs attention with a blocking finding
- **WHEN** `review-2` returns `needs-attention` with a finding that blocks under the active policy
- **THEN** the issue SHALL route to `fix-2`

#### Scenario: round 2 needs attention but nothing blocks
- **WHEN** `review-2` returns `needs-attention` with findings that are all advisory or overridden under
  the active policy
- **THEN** the issue SHALL advance to `pre-merge` with an audited "advanced under severity policy" record
