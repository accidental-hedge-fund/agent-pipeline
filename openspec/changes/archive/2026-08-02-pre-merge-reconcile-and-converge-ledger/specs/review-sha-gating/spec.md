## ADDED Requirements

### Requirement: Review-SHA gate decisions SHALL consume review-currency reconcile outputs

Before the pipeline acts on a prior review verdict, it SHALL obtain reuse / re-review / hold
disposition from the review-verdict currency reconcile surface (or a thin wrapper that implements
the same rules). Product rules for exact-SHA match, pipeline-internal-only commits, diff-hash reuse,
delta vs full re-review, and unresolved blocking-key holds remain as already specified; this
requirement consolidates decision authority into reconcile rather than stage-local terminalization
side paths.

#### Scenario: SHA-match approval still requires resolved blockers

- **WHEN** review-currency reconcile observes reviewed SHA matching HEAD
- **AND** unresolved blocking keys remain
- **THEN** the gate SHALL NOT advance as if approved
- **AND** SHALL hold at pre-merge for those keys without inventing human-decision authority

#### Scenario: Recurrence or ceiling counts are inputs not independent human holds

- **WHEN** finding recurrence or ceiling evidence is available at gate time
- **THEN** that evidence SHALL feed reconcile / recovery routing
- **AND** SHALL NOT alone apply `pipeline:needs-human` without current
  `human-decision-required` authority evidence
