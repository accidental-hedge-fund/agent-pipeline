## ADDED Requirements

### Requirement: Correction auto-filed issue bodies SHALL stamp engine identity and discovery-channel

When the engine auto-files a correction issue, the issue body SHALL include machine-readable
engine version and commit SHA stamps (or explicit unresolved markers) and a
discovery-channel stamp of `papercut-autofile`, in addition to the existing correction
auto-file provenance marker and sanitized evidence. Category-specific rate-cap
reconciliation SHALL continue to key on the correction provenance marker only.

#### Scenario: New correction auto-file carries attribution stamps

- **WHEN** a correction cluster is auto-filed and engine identity is resolvable
- **THEN** the created issue body SHALL include the correction category provenance marker
- **AND** it SHALL include engine version, commit SHA, and discovery-channel
  `papercut-autofile`

#### Scenario: Correction budget ignores papercut-only stamps

- **WHEN** reconciliation counts open in-window correction-auto-filed issues
- **THEN** it SHALL require the correction provenance marker
- **AND** it SHALL NOT treat engine/discovery stamps alone as sufficient to count toward
  the correction budget
