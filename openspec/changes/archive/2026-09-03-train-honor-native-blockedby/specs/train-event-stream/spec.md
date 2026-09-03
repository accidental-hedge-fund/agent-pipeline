## ADDED Requirements

### Requirement: Train work-list-resolved events SHALL record discovery provenance and ignored edges

The `train_work_list_resolved` event SHALL include enough structured fields for an operator
to audit which admitted edges were used and which declared candidates were ignored when a
live (non-dry-run) train is admitted after complete discovery. Those fields SHALL identify
contributing sources for admitted edges (lexical, native `blockedBy`, roadmap-declared when
enabled) and SHALL include ignored-edge dispositions with stable reason codes
(`not_on_selector`, `closed`, `not_open`). `schema_version` SHALL remain `1`. Readers SHALL
preserve unknown additive fields. Train SHALL NOT silently drop provenance after using the
graph. Dry-run SHALL log the same observation identity and ignored-edge dispositions without
writing a run store.

#### Scenario: Native edge provenance is on the work-list event

- **WHEN** a live train admits issue 1323 depending on 1322 solely from native `blockedBy`
- **THEN** `train_work_list_resolved` SHALL identify that admitted edge's source as native
  `blockedBy`
- **AND** a caller SHALL NOT need to re-parse issue bodies to learn that source

#### Scenario: Ignored off-selector candidate remains visible

- **WHEN** discovery observes that selected issue A is natively blocked by off-selector
  issue Z
- **AND** hard-wait admission ignores Z as `not_on_selector`
- **THEN** the work-list-resolved observation SHALL include that ignored disposition
- **AND** Z SHALL NOT remain an admitted hard wait on A

#### Scenario: Dry-run does not write provenance to a run store

- **WHEN** a dry-run train fully observes native and lexical sources
- **THEN** it SHALL still make provenance and ignored-edge dispositions observable in its
  printed plan or logs
- **AND** it SHALL NOT create `.agent-pipeline/runs/train-*/` in order to record them
