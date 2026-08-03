## MODIFIED Requirements

### Requirement: Enabled correction auto-filing SHALL reuse the papercut auto-file controls

When `corrections.auto_file` is `true`, the engine SHALL cluster in-window `correction_event`
records and auto-file qualifying clusters using the same open-issue deduplication, sanitization,
provenance, and cross-host post-create reconciliation machinery shipped for papercut auto-filing
(#421 / #459), with a correction-specific provenance marker. The per-window rate cap SHALL be
**independent** of the papercut and durable-run-blocker caps: the engine SHALL file at most
`corrections.auto_file_max_per_window` open correction-auto-filed issues within the trailing
`corrections.auto_file_window_hours` window. An issue SHALL count toward this cap only when it is
open, carries `pipeline:backlog`, was created inside that window, and its body includes the
correction auto-file provenance marker. Papercut-auto-filed issues, durable-run-blocker-auto-filed
issues, human-managed backlog issues, and `pipeline improve --apply` issues SHALL NOT count.
Pre-create cap checks and post-create rate-cap reconciliation for corrections SHALL use that same
membership rule. Clusters below the minimum-occurrence threshold SHALL be reported but not filed.

#### Scenario: Recurring in-window correction cluster is filed

- **WHEN** `corrections.auto_file` is `true` and a correction cluster inside the window meets the
  minimum distinct-occurrence threshold
- **THEN** the engine SHALL create one GitHub issue for that cluster without any human command

#### Scenario: Below-threshold correction cluster is reported but not filed

- **WHEN** a correction cluster's in-window distinct-occurrence count is below the minimum
- **THEN** no correction issue SHALL be auto-created for it

#### Scenario: Existing open issue suppresses correction auto-filing

- **WHEN** a qualifying correction cluster's proposed `[pipeline-improve]` title matches an open issue
- **THEN** no new issue SHALL be auto-created for that cluster

#### Scenario: Rate cap bounds correction auto-filing independently

- **WHEN** the open in-window correction-auto-filed count has reached
  `corrections.auto_file_max_per_window`
- **THEN** no additional correction issue SHALL be created for that window
- **AND** remaining qualifying correction clusters SHALL appear marked as deferred

#### Scenario: Papercut or durable filings do not exhaust the correction cap

- **WHEN** open in-window papercut-auto-filed and/or durable-run-blocker-auto-filed issues already
  meet or exceed those categories' own maxima, and the open in-window correction-auto-filed count
  is still below `corrections.auto_file_max_per_window`
- **THEN** a qualifying correction cluster SHALL still be eligible for auto-filing

#### Scenario: Correction rate-cap reconcile does not close other categories

- **WHEN** post-create correction rate-cap reconciliation runs after a correction create
- **THEN** it SHALL only consider open issues carrying the correction auto-file provenance marker
- **AND** it SHALL NOT close open papercut-auto-filed or durable-run-blocker-auto-filed issues
  solely to enforce the correction cap

### Requirement: Correction auto-filing SHALL inherit the shared cross-host auto-file machinery

Correction auto-filing SHALL use the same cross-host-safe path as papercut auto-filing: GitHub-
authored issue state as the source of truth for pre-create dedup and rate-cap checks, plus
post-create read-back reconciliation for duplicate titles and correction-scoped rate-cap overflow.
Documentation and configuration comments SHALL state that this path inherits that shared
cross-host posture. They SHALL NOT claim that correction auto-filing is single-host-only while
the implementation reuses cross-host reconciliation, and SHALL NOT invent a stronger global-
serialization guarantee than the shared path provides. Host-local `/tmp` locks remain a same-host
fast path only.

#### Scenario: Shared cross-host posture is documented consistently

- **WHEN** the correction auto-file configuration and its documentation are inspected alongside
  papercut and durable-run-blocker auto-file docs
- **THEN** all three SHALL describe the same cross-host auto-file posture (GitHub-authored state
  plus post-create reconciliation)
- **AND** none SHALL claim single-host-only scope for the auto-file path while another claims
  cross-host safety for the same machinery

#### Scenario: Single-host run performs no false reconciliation claim

- **WHEN** a single host auto-files a correction cluster and no duplicate title or
  correction-scoped rate-cap overflow exists
- **THEN** the engine SHALL close no issue
- **AND** the output SHALL not assert any cross-host deduplication was performed
