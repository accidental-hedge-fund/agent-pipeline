## ADDED Requirements

### Requirement: Pre-merge auto-fix SHALL declare scope and run candidate-integrity around head movement

The pre-merge bounded auto-fix path SHALL supply a declared repair scope, capture a pre-mutation candidate-integrity manifest before head-moving side effects, and after a successful commit or published head change classify the transition with `mutation_method` of `pre_merge_autofix` whenever the path may change the candidate head. An `expected_scoped_change` classification or any classification that advances the candidate SHA SHALL force fresh review against the new SHA via the existing pre-merge delta-review or re-review path before readiness. A `scope_expansion` or `unverified` classification SHALL invalidate prior review and readiness and MUST NOT silently complete pre-merge toward ready-to-deploy.

#### Scenario: Auto-fix that changes the candidate forces re-review

- **WHEN** pre-merge auto-fix produces a new candidate SHA with content changes inside the declared repair scope
- **THEN** candidate-integrity classification SHALL be `expected_scoped_change`
- **AND** the pre-merge path SHALL re-review (delta or equivalent) against the new head before treating the entry as review-clean
- **AND** prior review for the old SHA SHALL NOT alone authorize readiness

#### Scenario: Auto-fix scope expansion fails closed

- **WHEN** post-auto-fix comparison finds undeclared path or content changes outside the declared repair scope
- **THEN** classification SHALL be `scope_expansion`
- **AND** the path SHALL invalidate readiness authority from prior review
- **AND** SHALL NOT advance the issue to ready-to-deploy on that head

#### Scenario: Clean no-commit auto-fix still classifies when head unchanged

- **WHEN** auto-fix ends with a clean worktree and no new commit (existing noop path)
- **AND** the authoritative candidate SHA is unchanged
- **THEN** candidate-integrity MAY record a no-movement or equivalent non-mutation outcome without inventing scope expansion
- **AND** existing clean-noop re-verify requirements remain in force
