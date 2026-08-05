## ADDED Requirements

### Requirement: Review rounds SHALL consume a single merged verdict when review ensemble is enabled

When `review_ensemble` is enabled, each plan-review, review-1, and review-2 round SHALL obtain its
structured verdict and findings from the ensemble merge path defined by the `review-ensemble`
capability, then apply the existing verdict-driven routing, comment-before-transition, and
`partitionFindings` policy gates unchanged. The round SHALL still produce exactly one disposition
outcome (advance, fix route, ceiling, or needs-human) from that single merged finding set. When
ensemble is disabled or absent, the review backend SHALL continue to invoke exactly one reviewer
as specified by existing `reviewMode` / `prompt-harness` requirements.

#### Scenario: ensemble-enabled round still posts one comment before routing

- **WHEN** ensemble is enabled and a review-1 round completes with a merged `needs-attention`
  verdict containing a policy-blocking finding
- **THEN** the engine SHALL post the single formatted review comment before the stage transition
- **AND** SHALL route to `fix-1` under the same policy rules as a single-reviewer blocking verdict

#### Scenario: ensemble-disabled path unchanged

- **WHEN** ensemble is disabled and review-2 returns `approve`
- **THEN** the issue SHALL advance to `pre-merge` exactly as in the single-reviewer path
- **AND** no additional reviewer harness SHALL be invoked for that round

#### Scenario: routing remains policy-driven after merge

- **WHEN** ensemble merge yields findings that are all advisory or overridden under the active
  `review_policy`
- **THEN** the issue SHALL advance as if approved with an audited severity-policy record
- **AND** SHALL NOT introduce a separate multi-agent routing label
