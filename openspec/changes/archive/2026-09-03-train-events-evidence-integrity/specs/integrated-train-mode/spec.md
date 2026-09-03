## MODIFIED Requirements

### Requirement: Train JSON mode SHALL emit one final object on stdout

When `pipeline train` is invoked with `--json` and without `--dry-run`, stdout SHALL contain exactly one unfenced JSON object whose `kind` is `train_status`. That object SHALL include an additive `run_id` field set to the durable train-level run ID when the train run store was initialized (`schema_version` remains `1`). Additive `events_coverage` SHALL be one of `ok`, `degraded`, or `unknown` when present. When exclusive identity allocation succeeds and event init succeeds, `events_coverage` MAY be `ok` or omitted and `run_id` SHALL be set. When every exclusive create fails with `EEXIST`, that object SHALL omit `run_id`, SHALL omit `train_run_handoff`, and SHALL set `events_coverage` to `degraded`. When exclusive create fails with a non-`EEXIST` error before any claim succeeds, that object SHALL omit `run_id`, SHALL omit `train_run_handoff`, and SHALL set `events_coverage` to `unknown`. When store-file initialization fails after an exclusive claim, or a live-link append fails after a published store, or a later wave identity disagrees with the live link, that object SHALL set `events_coverage` to `degraded` and SHALL keep `run_id` when a store was published. Those coverage values SHALL NOT change merge decisions, which issues advance, retry behavior, exit status, or stdout object kind. When `pipeline train` is invoked with `--json` and `--dry-run`, stdout SHALL contain exactly one unfenced JSON object whose `kind` is `train_plan` as defined by the `train-dry-run` capability, and SHALL NOT emit `train_status` on that stdout stream. Nested `single` runs SHALL NOT write handoff, status, or terminal JSON objects to that stdout stream. `train_run_handoff` and train `events.jsonl` lines SHALL NOT appear on that stdout stream. Human diagnostics, `train_run_handoff`, and child progress MAY use stderr or the existing run event streams.

#### Scenario: Successful train output parses once

- **WHEN** a train advances two issues successfully with `--json`
- **THEN** one `JSON.parse` of the complete stdout SHALL return the final
  `train_status` object
- **AND** no child-run JSON SHALL precede or follow that object

#### Scenario: Child progress remains observable

- **WHEN** a child issue run emits handoff or stage progress during a JSON train
- **THEN** that progress SHALL remain available through stderr and/or the exact
  child run's events
- **AND** it SHALL NOT corrupt the final train JSON object

#### Scenario: train_status carries run_id

- **WHEN** a JSON train initializes a train run store with id `train-2026-08-28T17-28-03-000Z`
- **THEN** the stdout `train_status` object SHALL include `run_id` equal to
  `train-2026-08-28T17-28-03-000Z`
- **AND** `schema_version` SHALL remain `1`

#### Scenario: JSON dry-run is train_plan not train_status

- **WHEN** a train is invoked with `--json` and `--dry-run` and planning succeeds
- **THEN** one `JSON.parse` of the complete stdout SHALL return an object whose `kind` is `train_plan`
- **AND** that stdout SHALL NOT contain a `train_status` object

#### Scenario: Exhausted allocation reports coverage on the same status object

- **WHEN** a JSON train cannot exclusively publish a train run directory
- **THEN** one `JSON.parse` of the complete stdout SHALL return the final `train_status` object
- **AND** that object SHALL include `events_coverage` equal to `degraded` or `unknown`
- **AND** that object SHALL omit `run_id`
- **AND** `schema_version` SHALL remain `1`

#### Scenario: Published-store observation failure keeps run_id

- **WHEN** a JSON train published a store
- **AND** a later live-link append fails or a later wave identity disagrees
- **THEN** the stdout `train_status` object SHALL include `run_id` equal to the published id
- **AND** SHALL set `events_coverage` to `degraded`
- **AND** stdout SHALL still parse as exactly one `train_status` object
