## ADDED Requirements

### Requirement: Pre-merge domain modules SHALL expose reconcile-shaped surfaces

Pre-merge domain modules (SHA-gate, OpenSpec archive, CI gate, conflict/rebase) SHALL expose
`reconcile(observedState) → actions` (or equivalent named exports) that derive gate actions from
authoritative observed state, rather than only encoding irreversible linear side effects in a fixed
gate order. The thin `pre_merge.ts` facade MAY sequence those reconcile results. This requirement
coordinates with the pre-merge module split (#628) without requiring that split's full move-only
body to land in the same change; new consolidation for attempt ledger and currency SHALL land behind
reconcile-shaped APIs so a later split does not reintroduce private marker authorities.

#### Scenario: CI domain reconcile returns attempt-aware actions

- **WHEN** the CI-gate domain reconcile runs with observed definitive red checks and ledger state
  for head `H`
- **THEN** it SHALL return ordered recovery or escalate actions based on remaining ledger budget
- **AND** SHALL NOT require a private in-module marker file as sole authority

#### Scenario: SHA-gate domain reconcile returns currency actions

- **WHEN** the SHA-gate domain reconcile runs with reviewed SHA, HEAD, and blocking-key evidence
- **THEN** it SHALL return reuse, re-review, or hold actions
- **AND** SHALL NOT independently terminalize to human hold without authority evidence

#### Scenario: Facade may sequence without owning private books

- **WHEN** the pre_merge facade advances an issue through pre-merge
- **THEN** it MAY order domain reconcile results
- **AND** attempt authority SHALL remain the stage-attempt ledger rather than facade-local maps
