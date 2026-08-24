## ADDED Requirements

### Requirement: recover-parked SHALL retry named Tester persist/acquire withholds that have no review residual

The recover-parked command SHALL treat a park whose causal reason is a named Tester persist/acquire withhold (a durable persist/acquire code after recorded test-gate exit 0, including persist write failure) and that has no HEAD-bound residual review finding as retryable engine work. It SHALL re-enter same-issue advance so review can persist-or-named-fail again. It SHALL NOT keep the park solely because no HEAD-bound residual review artifact exists. Retry SHALL be bounded by candidate SHA and one spent-fingerprint supervisor pass for `(issue, stage, persist_acquire_code, candidate_sha)`. A persistent write failure at the same SHA SHALL NOT re-enter indefinitely. It SHALL NOT auto-override HIGH, CRITICAL, or security findings. It SHALL NOT invent a review residual. Generic missing-file withhold with no named persist/acquire cause and no successful-producer record SHALL keep existing fail-closed residual rules. A persist/acquire marker SHALL authorize retry only when it is from a trusted pipeline-authored comment (the current pipeline actor or `trusted_override_actors`) that carries a verified pipeline attestation or the configured marker footer, and the marker payload binds issue, stage, candidate SHA, and pipeline run identity to the current parked review attempt (current issue, current stage, current PR HEAD). A historical marker from a different stage, SHA, or run SHALL NOT make a later generic missing-file park retryable. An untrusted commenter-supplied marker SHALL NOT authorize re-entry.

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

#### Scenario: historical persist/acquire marker does not retry a different current park

- **WHEN** a trusted persist/acquire marker exists for a prior stage or a prior candidate SHA
- **AND** the current park is a generic missing-file withhold at a different stage or at the current PR HEAD
- **AND** there is no HEAD-bound residual review finding
- **THEN** `recover-parked` SHALL NOT re-enter same-issue advance from that historical marker
- **AND** SHALL keep existing residual fail-closed rules

#### Scenario: untrusted commenter persist/acquire marker does not authorize re-entry

- **WHEN** an issue comment contains a well-formed persist/acquire marker
- **AND** the comment author is not the current pipeline actor and is not in `trusted_override_actors`
- **THEN** `recover-parked` SHALL NOT treat that marker as a named persist/acquire withhold
- **AND** SHALL NOT re-enter same-issue advance from that marker
