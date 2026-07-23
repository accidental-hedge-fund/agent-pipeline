## MODIFIED Requirements

### Requirement: A configured sink receives every event as the same JSON line
When an event sink is active, each event that the run appends to `events.jsonl` SHALL also be delivered to the sink as the identical newline-terminated JSON line. Delivery SHALL cover all event producers that flow through `appendEvent` (stage lifecycle, `run_start`/`run_complete`, `pr_created`/`pr_updated`, `worktree_created`/`worktree_removed`, `review_verdict`, `blocker_set`/`blocker_cleared`, `gh_metrics_summary`, `stage_accounting`, `human_intervention`, `papercut`, and `correction_event`). The delivered records SHALL be the same structured records currently written to `events.jsonl` — screened by the write-time injection denylist and secret redaction before delivery — with no new fields and no change to `schema_version` (which SHALL remain `1`). Delivery SHALL preserve the order in which events are appended.

#### Scenario: every appended event reaches the sink
- **WHEN** an event sink is active and a stage lifecycle, `review_verdict`, or `stage_accounting` event is appended
- **THEN** the sink SHALL receive the same JSON line that is written to `events.jsonl`

#### Scenario: papercut events reach the sink like any other event
- **WHEN** an event sink is active and a `papercut` event is appended for a run
- **THEN** the sink SHALL receive the same JSON line that is written to `events.jsonl`, on identical terms to `blocker_set` and `human_intervention`

#### Scenario: correction_event reaches the sink byte-identically
- **WHEN** an event sink is active and a `correction_event` is appended for a run
- **THEN** the sink SHALL receive the same JSON line that is written to `events.jsonl`, on identical terms to `human_intervention` and `papercut`
- **AND** the delivered line SHALL already be screened by the injection denylist and secret redaction

#### Scenario: delivered line is byte-identical to the events.jsonl line
- **WHEN** an event is delivered to the sink
- **THEN** the delivered content SHALL be identical to the line written to `events.jsonl` for that same event
- **AND** it SHALL already be screened by the injection denylist and secret redaction

#### Scenario: no schema change for the sink
- **WHEN** events are delivered to a sink
- **THEN** the events SHALL carry no additional fields introduced for sink delivery
- **AND** `schema_version` SHALL remain `1`

#### Scenario: delivery preserves append order
- **WHEN** multiple events are appended in sequence with an active sink
- **THEN** the sink SHALL receive them in the same order they are appended to `events.jsonl`
