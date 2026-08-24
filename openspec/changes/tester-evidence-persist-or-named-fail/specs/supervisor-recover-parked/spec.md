## ADDED Requirements

### Requirement: recover-parked SHALL retry named Tester persist/acquire withholds that have no review residual

The recover-parked command SHALL treat a park whose causal reason is a named Tester persist/acquire withhold (a durable persist/acquire code after recorded test-gate exit 0, including persist write failure) and that has no HEAD-bound residual review finding as retryable engine work. It SHALL re-enter same-issue advance so review can persist-or-named-fail again. It SHALL NOT keep the park solely because no HEAD-bound residual review artifact exists. Retry SHALL be bounded by candidate SHA and one spent-fingerprint supervisor pass for `(issue, stage, persist_acquire_code, candidate_sha)`. A persistent write failure at the same SHA SHALL NOT re-enter indefinitely. It SHALL NOT auto-override HIGH, CRITICAL, or security findings. It SHALL NOT invent a review residual. Generic missing-file withhold with no named persist/acquire cause and no successful-producer record SHALL keep existing fail-closed residual rules.

#### Scenario: named persist/acquire withhold re-enters advance

- **WHEN** the item is parked because review withheld with a named Tester persist/acquire reason
- **AND** there is no HEAD-bound residual review finding
- **THEN** `recover-parked` SHALL re-enter same-issue advance (`pipeline single` or equivalent)
- **AND** SHALL NOT return `still-parked` solely because no HEAD-bound residual review artifact exists
- **AND** SHALL NOT record a supervisor override for a review finding that is not present

#### Scenario: HIGH residual still refuses override

- **WHEN** a HEAD-bound residual review finding is HIGH, CRITICAL, or security-category
- **THEN** `recover-parked` SHALL NOT auto-override that finding
- **AND** the persist/acquire retry path SHALL NOT unlock that override

#### Scenario: same-SHA persist/acquire retry is spent after one pass

- **WHEN** recover-parked has already spent the fingerprint for `(issue, stage, persist_acquire_code, candidate_sha)`
- **AND** the park is still a named persist/acquire withhold at that same SHA
- **THEN** recover-parked SHALL return `already-spent` (or keep the park)
- **AND** SHALL NOT re-enter same-issue advance again for that fingerprint
- **AND** a later persist/acquire withhold at a different candidate SHA MAY take one new pass

#### Scenario: generic missing without producer success stays fail-closed on residual rules

- **WHEN** the park reason is only the generic missing-file withhold
- **AND** there is no record that the producer recorded test-gate exit 0
- **AND** there is no HEAD-bound residual review artifact
- **THEN** `recover-parked` MAY keep the park under existing residual fail-closed rules
- **AND** SHALL NOT invent a DNR override from historical SHAs
