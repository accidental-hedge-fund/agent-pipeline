# correction-auto-file Specification

## Purpose
TBD - created by archiving change correction-compiler. Update Purpose after archive.
## Requirements
### Requirement: Correction auto-filing SHALL be opt-in and fully inert by default

The engine SHALL auto-file backlog issues from recurring `correction` clusters only when a
`corrections.auto_file` setting resolves to `true`. When the `corrections` block is absent, or when
`auto_file` is absent or `false`, the engine SHALL create no issues at run completion or at
queue-batch completion for correction clusters, SHALL make no `gh` calls on behalf of this feature,
and SHALL produce output, artifacts, event streams, and exit status identical to the behaviour before
this feature existed.

#### Scenario: Default configuration files nothing

- **WHEN** a run reaches `run_complete` with no `corrections.auto_file` configured
- **THEN** no correction issue SHALL be created
- **AND** the run's events, `summary.json`, printed output, and exit status SHALL be identical to the
  pre-feature behaviour

#### Scenario: Capture present but auto-file off still files nothing

- **WHEN** `correction_event` records exist and `corrections.auto_file` is absent or `false`
- **THEN** the corrections SHALL still be readable and reportable by `pipeline improve`
- **AND** no issue SHALL be auto-created

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

### Requirement: Auto-filed correction issues SHALL be sanitized, backlog-only, and provenance-declared

Every auto-filed correction issue SHALL carry only the `pipeline:backlog` label, no assignee, no
milestone, and no pipeline stage label; the engine SHALL NOT enqueue it or advance it. Its body SHALL
contain the cluster's sanitized evidence bundle and control-level proposal — passed through secret
redaction and injection screening before creation — and SHALL explicitly state that its content is
agent-reported, automatically filed by the pipeline, and not human-authored or human-verified.

#### Scenario: Auto-filed correction issue is backlog-only

- **WHEN** an issue is auto-filed from a correction cluster
- **THEN** it SHALL carry only the `pipeline:backlog` label and SHALL NOT be queued or advanced

#### Scenario: A secret in a correction never reaches the auto-filed body

- **WHEN** a source correction contains a token matching a recognized secret pattern
- **THEN** the created issue body SHALL contain the redacted form and SHALL NOT contain the raw secret

#### Scenario: Body declares agent-reported provenance

- **WHEN** an auto-filed correction issue body is read
- **THEN** it SHALL explicitly state that the content is agent-reported and automatically filed by the
  pipeline rather than human-authored

### Requirement: Correction auto-filing SHALL never fail a run, stage, or batch

The correction auto-file path SHALL be best-effort and total: any error it encounters —
unauthenticated `gh`, network failure, a throwing issue creation, unreadable run artifacts — SHALL be
caught, surfaced as a non-fatal warning, and swallowed. It SHALL NOT change a run's or batch's exit
status, SHALL NOT mark any stage as failed, SHALL NOT emit a `blocker_set` event, and SHALL NOT
prevent `run_complete`, `summary.json`, or `batch-summary.json` from being written.

#### Scenario: Issue creation failure is non-fatal

- **WHEN** correction auto-filing is enabled and the GitHub issue-creation call throws
- **THEN** the engine SHALL log a non-fatal warning
- **AND** the run or batch SHALL complete with the same exit status it would have had with
  auto-filing disabled

#### Scenario: Finalization artifacts are still written

- **WHEN** the correction auto-file path fails at run finalization
- **THEN** `run_complete` and `summary.json` SHALL still be written for that run

### Requirement: Correction auto-filing SHALL honor the single-host concurrency scope

Correction auto-filing SHALL use the same cross-host-safe path as papercut auto-filing: GitHub-
authored issue state as the source of truth for pre-create dedup and rate-cap checks, plus
post-create read-back reconciliation for duplicate titles and correction-scoped rate-cap overflow.
Documentation and configuration comments SHALL state that this path inherits that shared
cross-host posture. They SHALL NOT claim that correction auto-filing is single-host-only while
the implementation reuses cross-host reconciliation, and SHALL NOT invent a stronger global-
serialization guarantee than the shared path provides. Host-local `/tmp` locks remain a same-host
fast path only. The prior "single-host-only" concurrency claim for this path is superseded by the
shared papercut/durable cross-host auto-file machinery (#459 / #631).

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

