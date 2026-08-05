## ADDED Requirements

### Requirement: Papercut auto-filed issue bodies SHALL stamp engine identity and discovery-channel

When the engine auto-files a papercut issue, the issue body SHALL include machine-readable
engine version and commit SHA stamps (or explicit unresolved markers) and a
discovery-channel stamp of `papercut-autofile`, in addition to the existing papercut
auto-file provenance marker, agent-reported provenance banner, and sanitized evidence
detail. Stamping SHALL NOT change labels, rate-cap accounting, or cross-host reconciliation
rules that key on the category provenance marker.

#### Scenario: New papercut auto-file carries attribution stamps

- **WHEN** a papercut cluster is auto-filed and engine version and SHA are resolvable
- **THEN** the created issue body SHALL include the papercut category provenance marker
- **AND** it SHALL include engine version and commit SHA stamps
- **AND** it SHALL include discovery-channel `papercut-autofile`

#### Scenario: Rate-cap reconciliation still recognizes the issue

- **WHEN** an auto-filed papercut issue includes the new attribution stamps
- **THEN** open-issue rate-cap and duplicate reconciliation that filter on the papercut
  provenance marker SHALL still count the issue toward the papercut category budget
