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

When `review_policy.risk_proportional` is enabled, the `review-2` round SHALL evaluate its findings
against a **risk-scaled effective threshold** rather than the configured `block_threshold` directly: the
`review-1` round's structured risk tier (low when `review-1` approved with zero findings, standard
otherwise) SHALL be captured and propagated to `review-2`, and a **low** tier SHALL raise the effective
`review-2` threshold to the stricter of the configured `block_threshold` and `high`. The scaling SHALL
never produce an effective threshold looser than `high` for a low-risk change, never produce one
stricter than the configured `block_threshold`, and SHALL leave the configured threshold unchanged for
`review-1` and for any standard-risk `review-2`. (The capture, propagation, and effective-threshold
semantics are specified by `review-risk-proportional-blocking`.)

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

#### Scenario: round 2 blocking is risk-scaled when review-1 was low-risk
- **WHEN** `review_policy.risk_proportional` is enabled, `review-1` approved with zero findings, the
  configured `block_threshold` is `medium`, and `review-2` returns `needs-attention` with only
  `medium`-severity findings
- **THEN** the issue SHALL advance to `pre-merge` under the risk-scaled effective threshold rather than
  routing to `fix-2`
