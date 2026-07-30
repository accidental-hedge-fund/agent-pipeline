## ADDED Requirements

### Requirement: Active advance linkage SHALL enable pre-merge progress join keys

The loop SHALL use the `item_id`, `pipeline_run_id`, and absolute `events` path
from `loop_item_advance_linked` as the join keys for subsequent material
pre-merge progress events for that dispatch attempt. Consumers SHALL be able to
correlate progress lines to the same advance run store as the start linkage
without scanning unrelated runs. Progress emission requirements live in the
`loop-pre-merge-gate-sub-events` capability; this requirement only binds
join-key continuity.

#### Scenario: Progress uses the same pipeline_run_id as start linkage

- **WHEN** start linkage for item `554` publishes `pipeline_run_id`
  `554-2026-07-29T17-23-40-332Z` and absolute `events` path `E`
- **AND** a material pre-merge progress event is later appended for that
  dispatch attempt
- **THEN** that progress event SHALL carry `item_id` equal to `554` and
  `pipeline_run_id` equal to `554-2026-07-29T17-23-40-332Z`
- **AND** SHALL include absolute events path `E` when path inclusion is
  supported by the progress payload

#### Scenario: Distinct dispatch attempts keep distinct join keys

- **WHEN** the same item is dispatched twice with two different advance run ids
- **THEN** progress events for each attempt SHALL use that attempt’s own
  `pipeline_run_id`
- **AND** consumers SHALL join by `(item_id, pipeline_run_id)`, not by
  `item_id` alone
