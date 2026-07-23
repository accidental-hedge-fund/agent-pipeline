## ADDED Requirements

### Requirement: Delta-round governance event types SHALL be recognized in events.jsonl

`events.jsonl` SHALL recognize four additional event types, each carrying the run schema version and an ISO-8601 `at` timestamp like every other event:

- `delta_round` — fields: `round` (1-based number of this delta round for the item) and `cap` (the configured `review_policy.max_delta_rounds`).
- `delta_round_ceiling` — fields: `observed` (the durable delta-round count), `cap`, and `ceiling_action` (`park` or `demote_and_advance`).
- `delta_churn_suspected` — fields: `round`, and `axes` (each with the axis surface, the prior maximum confidence, and the new confidence).
- `settled_alternative_reinstated` — fields: `finding_key`, `surface`, `settled_finding_key`, `settling_round`, and `matched_alternative`.

These events SHALL be appended through the same append-only atomic write path as existing events, and SHALL be streamed by `--json-events` like any other lifecycle event.

#### Scenario: Delta round and ceiling events are appended

- **WHEN** a pre-merge delta round runs and a later entry reaches the configured cap
- **THEN** `events.jsonl` SHALL contain a `delta_round` record carrying `round` and `cap`
- **AND** SHALL contain a `delta_round_ceiling` record carrying `observed`, `cap`, and `ceiling_action`

#### Scenario: Churn and reinstatement events are appended

- **WHEN** a delta round is flagged as suspected churn and a finding is demoted for reinstating a settled rejected alternative
- **THEN** `events.jsonl` SHALL contain a `delta_churn_suspected` record naming the round and the involved axes with their prior and new confidences
- **AND** SHALL contain a `settled_alternative_reinstated` record naming the demoted key, surface, settled key, settling round, and matched alternative

#### Scenario: New event types stream over --json-events

- **WHEN** the run is invoked with `--json-events` and any of the four event types is emitted
- **THEN** the event SHALL be streamed to stdout in the same envelope as existing lifecycle events
