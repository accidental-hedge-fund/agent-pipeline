## ADDED Requirements

### Requirement: A ledger item that transitions to ready SHALL NOT keep a current blocked_theme

The durable loop store SHALL omit current `blocked_theme` from a ledger item when it records that item’s transition to coarse state `ready`. Prior history entries that recorded the block MAY remain. A recovery resume that transitions a blocked item to `in_progress` SHALL continue to retain `blocked_theme` so recovery identity still matches the class under resume. Consumers that consult `blocked_theme` as a live block SHALL do so only when `state === "blocked"`; a `ready` item SHALL NOT be treated as currently blocked because a leftover theme field is present.

#### Scenario: Ready transition clears current blocked_theme

- **WHEN** an item with `state: "in_progress"` and `blocked_theme: "implementation-ci"` transitions to `ready`
- **THEN** the written ledger entry for that item SHALL have `state: "ready"`
- **AND** it SHALL NOT expose a current `blocked_theme` of `implementation-ci`
- **AND** prior history that recorded the block SHALL remain readable

#### Scenario: Recovery resume to in_progress still retains blocked_theme

- **WHEN** a blocked item with `blocked_theme: "implementation-ci"` is recovered and resumes to `in_progress`
- **THEN** the written ledger entry SHALL keep `blocked_theme: "implementation-ci"`
- **AND** it SHALL NOT be required to clear theme solely because recovery succeeded

#### Scenario: Ready leftover theme is not treated as a live block

- **WHEN** a consumer reads a ledger item whose `state` is `ready` and a stale `blocked_theme` is present from a ledger written before this requirement
- **THEN** that consumer SHALL NOT treat the item as currently blocked solely because of that leftover theme
