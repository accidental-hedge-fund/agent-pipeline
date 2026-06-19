## ADDED Requirements

### Requirement: A reviewer-marked non-blocking finding is advisory regardless of severity or confidence

`partitionFindings` SHALL classify any finding whose `blocking` field is `false` as **advisory**,
independent of its `severity` and `confidence` and independent of the active `review_policy`
`block_threshold` / `min_confidence`. Such a finding SHALL NOT appear in the blocking set and SHALL
NOT route the item to a fix round, even when its severity is `critical` or `high`. A finding whose
`blocking` field is absent or `true` SHALL be classified exactly as before this change, by the
severity threshold and confidence floor. The advisory record for the finding SHALL state that it
was marked non-blocking by the reviewer.

#### Scenario: High-severity non-blocking finding does not block

- **WHEN** a `needs-attention` verdict contains a single finding with `severity: "high"` and
  `blocking: false`
- **THEN** that finding SHALL be advisory and the item SHALL advance rather than route to a fix round

#### Scenario: Critical non-blocking finding does not block

- **WHEN** a verdict contains a finding with `severity: "critical"` and `blocking: false`
- **THEN** that finding SHALL be advisory and SHALL NOT appear in the blocking set

#### Scenario: Unmarked finding still blocks

- **WHEN** a verdict contains a finding with `severity: "high"` and no `blocking` field (or
  `blocking: true`), at or above the policy threshold and confidence floor
- **THEN** that finding SHALL block exactly as before this change

#### Scenario: Non-blocking finding is itemized in the advance audit record

- **WHEN** a review advances because every finding was advisory or overridden, and one of the
  advisory findings was marked `blocking: false`
- **THEN** the audited advance comment SHALL itemize that finding and record that it did not block
  because the reviewer marked it non-blocking

### Requirement: A non-blocking finding is excluded from the key-override ambiguity guard

A finding whose `blocking` field is `false` SHALL NOT be counted as a blocking candidate when
`partitionFindings` computes the per-key set of distinct blocking-candidate payloads used by the
key-override ambiguity guard. A non-blocking finding that shares a stable key with a genuine
blocking finding SHALL NOT, by its presence, make that key ambiguous, so a recorded key override
for that key SHALL continue to apply to the blocking finding.

#### Scenario: Non-blocking sibling does not make a key ambiguous

- **WHEN** an operator has recorded a key override for key `K`
- **AND** a subsequent verdict contains one blocking finding with key `K` and one materially
  different `blocking: false` finding that also resolves to key `K`
- **THEN** the key `K` SHALL NOT be treated as ambiguous on account of the non-blocking finding
- **AND** the override SHALL apply to the blocking finding so it does not block
