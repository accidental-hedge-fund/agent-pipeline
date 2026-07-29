## ADDED Requirements

### Requirement: Stage-progress surfaces SHALL prefer the real advance run-store id from linkage

When a per-item stage-progress projection, audit stage table row, or stage-progress follow event includes an advance run identifier, that identifier SHALL be the real advance run-store directory basename published by start/terminal linkage (the basename of `.agent-pipeline/runs/<run-id>/`) whenever that real id is known. A synthetic `pipeline-loop-<loop-run-id>-<item-id>` string SHALL NOT be the only advance run id presented on those surfaces when a real run store id is known. When no real advance run id is known, the surface SHALL omit the drill-down id or mark it absent rather than inventing a live path.

#### Scenario: Audit drill-down uses the linked real run id

- **WHEN** start linkage for item `607` recorded `pipeline_run_id` `607-2026-07-27T19-31-29-328Z`
- **AND** the stage-progress audit table includes item `607`
- **THEN** the advance run id shown for drill-down SHALL equal `607-2026-07-27T19-31-29-328Z`
- **AND** SHALL NOT equal only a synthetic `pipeline-loop-…` string

#### Scenario: Follow event carries the same real run id

- **WHEN** a structured stage-progress event is emitted for an item with known real advance run id `607-2026-07-27T19-31-29-328Z`
- **THEN** that event's advance run id field SHALL equal `607-2026-07-27T19-31-29-328Z`

#### Scenario: Unknown linkage omits fabricated drill-down

- **WHEN** an item has never had a confirmed advance run store for the current attempt
- **THEN** stage-progress surfaces SHALL NOT present a fabricated path under `.agent-pipeline/runs/` as a live follow target for that item
