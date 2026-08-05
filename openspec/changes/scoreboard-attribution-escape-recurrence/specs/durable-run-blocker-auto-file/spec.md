## ADDED Requirements

### Requirement: Durable-run-blocker auto-filed issue bodies SHALL stamp engine identity and discovery-channel

When the engine auto-files a durable-run-blocker issue, the issue body SHALL include
machine-readable engine version and commit SHA stamps (or explicit unresolved markers) and
a discovery-channel stamp of `papercut-autofile`, in addition to the existing durable-run-
blocker provenance marker and sanitized evidence. Cross-host reconciliation and independent
per-category rate caps SHALL continue to key on the durable-run-blocker provenance marker.

#### Scenario: New durable-run-blocker auto-file carries attribution stamps

- **WHEN** a durable-run-blocker cluster is auto-filed and engine identity is resolvable
- **THEN** the created issue body SHALL include the durable-run-blocker category provenance
  marker
- **AND** it SHALL include engine version, commit SHA, and discovery-channel
  `papercut-autofile`

#### Scenario: Category budget remains independent

- **WHEN** open papercut-auto-filed issues have exhausted their category budget
- **AND** a durable-run-blocker auto-file is created with the new attribution stamps
- **THEN** the durable-run-blocker issue SHALL still count only toward the durable-run-
  blocker category budget
- **AND** discovery-channel `papercut-autofile` SHALL NOT merge the three auto-file
  budgets into one
