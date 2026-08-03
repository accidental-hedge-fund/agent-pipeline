## MODIFIED Requirements

### Requirement: Enabled durable-run-blocker auto-filing SHALL reuse the papercut auto-file controls

When a durable-run-blocker cluster qualifies, the engine SHALL create one `pipeline:backlog`
issue per not-already-tracked cluster, reusing the same open-issue deduplication, sanitization,
provenance marking, and cross-host post-create reconciliation shipped for papercut auto-filing
(#421 / #459), with a durable-run-blocker-specific provenance marker. The per-window rate cap
SHALL be **independent** of the papercut and correction caps: the engine SHALL file at most
`durable_runs.auto_file_max_per_window` open durable-run-blocker-auto-filed issues within the
trailing `durable_runs.auto_file_window_hours` window. An issue SHALL count toward this cap only
when it is open, carries `pipeline:backlog`, was created inside that window, and its body includes
the durable-run-blocker auto-file provenance marker. Papercut-auto-filed issues,
correction-auto-filed issues, human-managed backlog issues, and `pipeline improve --apply` issues
SHALL NOT count. Pre-create cap checks and post-create rate-cap reconciliation for this category
SHALL use that same membership rule. No separate deduplication or rate-cap *mechanism* SHALL be
introduced beyond the shared path parameterized by this category’s marker and budget. Auto-filing
SHALL require no human invocation of `pipeline improve --apply`.

#### Scenario: Existing open issue suppresses durable-run-blocker auto-filing

- **WHEN** a qualifying cluster's proposed `[pipeline-improve]` title matches an open issue
- **THEN** no new issue SHALL be auto-created for that cluster

#### Scenario: Rate cap bounds durable-run-blocker auto-filing independently

- **WHEN** the open in-window durable-run-blocker-auto-filed count has reached
  `durable_runs.auto_file_max_per_window`
- **THEN** no additional durable-run-blocker issue SHALL be created for that window
- **AND** the remaining qualifying clusters SHALL appear in the output marked as deferred

#### Scenario: Other categories do not exhaust the durable-run-blocker cap

- **WHEN** open in-window papercut-auto-filed and/or correction-auto-filed issues already meet or
  exceed those categories' own maxima, and the open in-window durable-run-blocker-auto-filed
  count is still below `durable_runs.auto_file_max_per_window`
- **THEN** a qualifying durable-run-blocker cluster SHALL still be eligible for auto-filing

#### Scenario: Durable rate-cap reconcile does not close other categories

- **WHEN** post-create durable-run-blocker rate-cap reconciliation runs after a create
- **THEN** it SHALL only consider open issues carrying the durable-run-blocker auto-file
  provenance marker
- **AND** it SHALL NOT close open papercut-auto-filed or correction-auto-filed issues solely to
  enforce the durable-run-blocker cap

#### Scenario: Provenance marker is distinct from other auto-file sources

- **WHEN** a durable-run-blocker issue is auto-filed
- **THEN** its body SHALL carry a provenance marker distinct from the papercut and correction
  auto-file markers, so cross-host reconciliation never conflates the three sources
