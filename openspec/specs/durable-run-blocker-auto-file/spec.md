# durable-run-blocker-auto-file Specification

## Purpose
TBD - created by archiving change durable-run-blocker-auto-file. Update Purpose after archive.
## Requirements
### Requirement: Durable-run-blocker auto-filing SHALL be opt-in and fully inert by default

The engine SHALL auto-file backlog issues from durable-run blocker clusters only
when a `durable_runs.auto_file` setting resolves to `true`. When the
`durable_runs` block is absent, or when `auto_file` is absent or `false`, the
engine SHALL create no issues at durable-run completion or terminal stop for
blocker clusters, SHALL make no `gh` calls on behalf of this feature, and SHALL
produce durable-run events, ledger contents, printed output, and exit status
identical to the behaviour before this feature existed.

#### Scenario: Default configuration files nothing

- **WHEN** a durable run reaches a terminal condition with no `durable_runs.auto_file` configured
- **THEN** no durable-run-blocker issue SHALL be created
- **AND** the run's events, ledger, printed output, and exit status SHALL be
  identical to the pre-feature behaviour

#### Scenario: Blockers present but auto-file off still files nothing

- **WHEN** durable-run ledgers carry typed blocker records and `durable_runs.auto_file` is absent or `false`
- **THEN** the blockers SHALL still be readable and reportable by `pipeline improve`
- **AND** no issue SHALL be auto-created

### Requirement: A durable-run-blocker cluster SHALL qualify on a terminal stop or a cross-run recurrence

When `durable_runs.auto_file` is `true`, the engine SHALL treat a
durable-run-blocker cluster as eligible to file when **either** a durable run
recorded a terminal run-stop attributable to that `(blocker class, evidence
fingerprint)`, **or** the same `(blocker class, evidence fingerprint)` occurs
across two or more distinct runs. A single non-terminal occurrence SHALL NOT
qualify. The cross-run recurrence threshold SHALL honor a configured
minimum-occurrence setting with a floor of 2; a terminal stop SHALL qualify
regardless of that count.

#### Scenario: Terminal-stop cluster files from a single run

- **WHEN** a single durable run recorded a terminal run-stop attributable to a
  blocker and `durable_runs.auto_file` is `true`
- **THEN** the engine SHALL create one `pipeline:backlog` issue for that cluster

#### Scenario: Repeated fingerprint across two runs files

- **WHEN** the same `(blocker class, evidence fingerprint)` occurs in two distinct
  durable runs and `durable_runs.auto_file` is `true`
- **THEN** the engine SHALL create one `pipeline:backlog` issue for that cluster

#### Scenario: Single non-terminal occurrence files nothing

- **WHEN** a blocker occurs in exactly one durable run and no terminal stop is
  attributable to it
- **THEN** no issue SHALL be auto-created for it
- **AND** the cluster SHALL NOT be reported as qualifying to file

### Requirement: Enabled durable-run-blocker auto-filing SHALL reuse the papercut auto-file controls

When a durable-run-blocker cluster qualifies, the engine SHALL create one
`pipeline:backlog` issue per not-already-tracked cluster, reusing unchanged the
same open-issue deduplication, per-window rate cap, sanitization, provenance
marking, and cross-host post-create reconciliation shipped for papercut
auto-filing (#421). No new deduplication or rate-cap mechanism SHALL be
introduced. Auto-filing SHALL require no human invocation of `pipeline improve
--apply`.

#### Scenario: Existing open issue suppresses durable-run-blocker auto-filing

- **WHEN** a qualifying cluster's proposed `[pipeline-improve]` title matches an
  open issue
- **THEN** no new issue SHALL be auto-created for that cluster

#### Scenario: Rate cap bounds durable-run-blocker auto-filing

- **WHEN** the configured per-window maximum of auto-filed issues has been reached
- **THEN** no additional durable-run-blocker issue SHALL be created for that window
- **AND** the remaining qualifying clusters SHALL appear in the output marked as deferred

#### Scenario: Provenance marker is distinct from other auto-file sources

- **WHEN** a durable-run-blocker issue is auto-filed
- **THEN** its body SHALL carry a provenance marker distinct from the papercut and
  correction auto-file markers, so cross-host reconciliation never conflates the
  three sources

### Requirement: Auto-filed durable-run-blocker issues SHALL be sanitized, backlog-only, and carry ledger reproduction context

Every auto-filed durable-run-blocker issue SHALL carry only the `pipeline:backlog`
label, no assignee, no milestone, and no pipeline stage label; the engine SHALL
NOT enqueue it or advance it. Its body SHALL contain the cluster's reproduction
context — the affected run ids, item ids, blocker class, evidence fingerprint, and
an evidence excerpt drawn from the ledger — passed through the store's existing
secret redaction and injection screening before creation, and SHALL explicitly
state that its content is agent/pipeline-reported, automatically filed by the
pipeline, and not human-authored or human-verified.

#### Scenario: Auto-filed issue is backlog-only

- **WHEN** an issue is auto-filed from a durable-run-blocker cluster
- **THEN** it SHALL carry only the `pipeline:backlog` label and SHALL NOT be queued or advanced
- **AND** it SHALL carry no milestone and no assignee

#### Scenario: Reproduction context is present and sanitized

- **WHEN** an auto-filed durable-run-blocker issue body is read
- **THEN** it SHALL contain the affected run ids, item ids, blocker class, and
  evidence fingerprint from the ledger
- **AND** any token matching a recognized secret pattern in the evidence SHALL
  appear only in redacted form and SHALL NOT appear raw

#### Scenario: Body declares agent/pipeline-reported provenance

- **WHEN** an auto-filed durable-run-blocker issue body is read
- **THEN** it SHALL explicitly state that the content is agent/pipeline-reported
  and automatically filed by the pipeline rather than human-authored

### Requirement: Durable-run-blocker auto-filing SHALL never fail a run, cycle, stage, or batch

The durable-run-blocker auto-file path SHALL be best-effort and total: any error
it encounters — unauthenticated `gh`, network failure, a throwing issue creation,
unreadable durable-run ledgers — SHALL be caught, surfaced as a non-fatal warning,
and swallowed. It SHALL NOT change a durable run's or batch's exit status, SHALL
NOT mark any stage or supervisor cycle as failed, SHALL NOT emit a blocker, and
SHALL NOT prevent the durable run's ledger finalization or terminal-stop recording.

#### Scenario: Issue creation failure is non-fatal

- **WHEN** durable-run-blocker auto-filing is enabled and the GitHub issue-creation call throws
- **THEN** the engine SHALL log a non-fatal warning
- **AND** the durable run SHALL complete with the same exit status it would have had with auto-filing disabled

#### Scenario: Ledger finalization is unaffected

- **WHEN** the durable-run-blocker auto-file path fails at durable-run terminal stop
- **THEN** the run's terminal-stop record and ledger finalization SHALL still be written

