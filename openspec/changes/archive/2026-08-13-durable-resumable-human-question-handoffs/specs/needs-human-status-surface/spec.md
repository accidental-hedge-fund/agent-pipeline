## ADDED Requirements

### Requirement: --status on needs-human SHALL surface pending human-question handoffs when present

When `--status` is invoked on an issue whose resolved stage is `needs-human` (or blocked with a human hold), and one or more durable human-question handoffs exist for that issue, the output SHALL include a handoff section listing each pending handoff's id, class, authority mode, age, and question summary, plus a pointer to inspect/answer commands. When no handoffs exist, the existing ceiling-comment punch-list behavior SHALL remain unchanged. The handoff section SHALL NOT replace the punch-list derived from the review ceiling comment.

#### Scenario: needs-human with pending handoffs lists them

- **WHEN** `--status` is called on an issue at stage `needs-human`
- **AND** at least one handoff with status `pending` exists for that issue
- **THEN** the output SHALL include each pending handoff id and a question summary
- **AND** SHALL still include the ceiling-comment punch-list behavior when a ceiling comment exists

#### Scenario: needs-human with no handoffs keeps prior behavior

- **WHEN** `--status` is called on an issue at stage `needs-human`
- **AND** no handoff records exist for that issue
- **THEN** the output SHALL match the pre-handoff punch-list behavior for that issue
- **AND** SHALL NOT require handoff storage to succeed

#### Scenario: status JSON includes handoff projections

- **WHEN** status is requested with JSON output and pending handoffs exist
- **THEN** the JSON SHALL include a handoffs array (or equivalent field) with id, status, class, and authority_mode
