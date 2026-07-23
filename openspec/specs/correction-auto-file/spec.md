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

When `corrections.auto_file` is `true`, the engine SHALL cluster in-window `correction_event` records
and create one `pipeline:backlog` issue per cluster whose distinct-occurrence count meets or exceeds
the configured minimum, reusing the same minimum-occurrence gate, open-issue deduplication,
per-window rate cap, sanitization, and provenance controls shipped for papercut auto-filing (#421).
The minimum-occurrence setting SHALL have a floor of 2. Clusters below the threshold SHALL be reported
but SHALL NOT be filed. Auto-filing SHALL require no human invocation of `pipeline improve --apply`.

#### Scenario: Recurring in-window correction cluster is filed

- **WHEN** `corrections.auto_file` is `true` and a correction cluster inside the window meets the
  minimum-occurrence threshold
- **THEN** the engine SHALL create one `pipeline:backlog` issue for that cluster without any human
  command

#### Scenario: Below-threshold correction cluster is reported but not filed

- **WHEN** a correction cluster's in-window distinct-occurrence count is below the minimum
- **THEN** no issue SHALL be auto-created for it
- **AND** the cluster SHALL still be visible in the run or batch output

#### Scenario: Existing open issue suppresses correction auto-filing

- **WHEN** a qualifying correction cluster's proposed `[pipeline-improve]` title matches an open issue
- **THEN** no new issue SHALL be auto-created for that cluster

#### Scenario: Rate cap bounds correction auto-filing

- **WHEN** the configured per-window maximum of auto-filed issues has been reached
- **THEN** no additional correction issue SHALL be created for that window
- **AND** the remaining qualifying clusters SHALL appear in the output marked as deferred

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

Correction auto-filing SHALL honor the concurrency scope of #459: until cross-host serialization
exists for this path, the runtime and its documentation SHALL state the supported single-host
constraint and SHALL NOT claim cross-host global deduplication for correction auto-filing. Any
cross-host convergence inherited from the reused papercut reconciliation SHALL be described only as
that inherited behaviour, and no new cross-host global-dedup guarantee SHALL be asserted for the
correction source beyond it.

#### Scenario: Single-host constraint is documented, not overclaimed

- **WHEN** the correction auto-file configuration and its documentation are inspected
- **THEN** they SHALL state that single-host operation is the supported concurrency scope for this
  path
- **AND** they SHALL NOT claim a cross-host global-deduplication guarantee for correction auto-filing

#### Scenario: Single-host run performs no false reconciliation claim

- **WHEN** a single host auto-files a correction cluster and no duplicate title exists
- **THEN** the engine SHALL close no issue
- **AND** the output SHALL not assert any cross-host deduplication was performed

