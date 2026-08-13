## ADDED Requirements

### Requirement: Batch summaries SHALL expose waiting-human handoff counts without treating them as agent capacity failures

The `queue` sub-command's machine-readable batch summary and human-readable batch report SHALL include waiting-human projections derived from pending human-question handoffs (and equivalent human holds) for items in the batch: at least a total `waiting_human_count` and, when available, oldest pending age. Waiting-human items SHALL NOT be classified as agent/compute capacity failures solely because they wait on a human. The queue SHALL NOT dispatch a blocked waiting-human item as if it were an available agent slot, and SHALL continue to select other eligible ready items subject to existing concurrency and budget caps.

#### Scenario: Batch summary counts pending handoffs

- **WHEN** a queue batch includes two items with pending human-question handoffs and three ready items
- **THEN** `batch-summary.json` (or equivalent) SHALL report `waiting_human_count` of at least 2
- **AND** SHALL still list or count the ready items separately for dispatch eligibility

#### Scenario: Waiting-human is not a capacity failure

- **WHEN** the only non-ready items in a batch are waiting on pending handoffs
- **THEN** the batch summary SHALL NOT increment agent/compute failure-rate counters solely for those waits
- **AND** SHALL expose them under the waiting-human projection

#### Scenario: Ready items continue while another waits

- **WHEN** item A has a pending handoff and item B is eligible and within concurrency/budget caps
- **THEN** the queue SHALL be allowed to dispatch item B
- **AND** SHALL NOT dispatch item A while it remains a waiting-human hold
