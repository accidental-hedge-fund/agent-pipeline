## ADDED Requirements

### Requirement: human_intervention is a recognized event type in events.jsonl
The `events.jsonl` format SHALL recognize `"human_intervention"` as a valid event `type` alongside the existing `stage_start`, `stage_complete`, `run_start`, `run_complete`, `pr_created`, `pr_updated`, `worktree_created`, `worktree_removed`, `review_verdict`, `blocker_set`, and `blocker_cleared` types. Readers SHALL NOT reject or skip `human_intervention` events when iterating the log. The `human_intervention` event type is additive and does not change `schema_version`.

#### Scenario: reader includes human_intervention events when iterating
- **WHEN** `readEvents()` is called on an `events.jsonl` containing a mix of `stage_complete` and `human_intervention` events
- **THEN** both event types SHALL be present in the returned array
- **AND** the reader SHALL NOT skip or drop `human_intervention` lines

#### Scenario: human_intervention events do not affect stage timeline reconstruction
- **WHEN** a consumer filters `events.jsonl` for `stage_start` and `stage_complete` events to reconstruct the stage timeline
- **THEN** `human_intervention` events SHALL be excluded by the type filter
- **AND** the stage timeline SHALL be identical to a log without `human_intervention` events
