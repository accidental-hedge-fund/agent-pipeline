## ADDED Requirements

### Requirement: Evidence bundle SHALL record governed override decisions and lifecycle state

The evidence bundle (or equivalent run evidence surface) SHALL include override decision records sufficient to distinguish `active`, `expired`, `superseded`, `renewed`, `rejected`, and `invalidated` outcomes for the run. Each recorded decision SHALL expose class, target, actor, authorization summary, timestamps (`created_at`, `expires_at`), lineage identifiers when present, evidence and remediation references, and evidence-subject binding or legacy-unbound disposition. Free-text reasons alone SHALL NOT be the only machine-readable representation of lifecycle state.

#### Scenario: active and expired decisions appear distinctly

- **WHEN** a run recorded one still-active decision and one expired decision
- **THEN** the evidence bundle SHALL list both
- **AND** their lifecycle fields SHALL differ (`active` vs `expired`)

#### Scenario: rejected attempt is visible

- **WHEN** an override recording attempt is refused for unauthorized or missing-evidence reasons
- **THEN** the run evidence or event stream SHALL retain a rejected outcome record for analysis
- **AND** SHALL NOT imply the finding was dispositioned

#### Scenario: renewal lineage is visible

- **WHEN** decision D2 renews D1
- **THEN** evidence SHALL allow a consumer to read D2’s link to D1
- **AND** to see both records without in-place mutation of D1

### Requirement: Evidence bundle SHALL support age and recurrence analysis fields

For each override decision in evidence, the bundle or accompanying machine-readable events SHALL include enough structured fields for consumers to compute decision age, class, authority actor, renewal count or lineage depth, and correlation to the finding or scope target for recurrence analysis.

#### Scenario: age and class are structured

- **WHEN** a consumer reads an override decision from the evidence bundle
- **THEN** it SHALL obtain `created_at`, `expires_at`, and `class` without parsing the human explanation paragraph
- **AND** SHALL obtain the target key or scope identity as structured fields
