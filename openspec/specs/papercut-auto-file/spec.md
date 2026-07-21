# papercut-auto-file Specification

## Purpose
TBD - created by archiving change papercut-backlog-clustering. Update Purpose after archive.
## Requirements
### Requirement: Papercut auto-filing SHALL be opt-in and fully inert by default

The engine SHALL auto-file backlog issues from recurring papercut clusters only when
`papercuts.auto_file` resolves to `true`. When the `papercuts` block is absent, when
`papercuts.enabled` is `false`, or when `auto_file` is absent or `false`, the engine SHALL create no
issues at run completion or at queue-batch completion, SHALL make no `gh` calls on behalf of this
feature, and SHALL produce output, artifacts, event streams, and exit status identical to the
behaviour before this feature existed.

#### Scenario: Default configuration files nothing at run completion

- **WHEN** a run reaches `run_complete` with no `papercuts` block configured
- **THEN** no issue SHALL be created
- **AND** the run's events, `summary.json`, printed output, and exit status SHALL be identical to the
  pre-feature behaviour

#### Scenario: Default configuration files nothing at queue-batch completion

- **WHEN** a `pipeline queue` batch completes with `papercuts.auto_file` unset or `false`
- **THEN** no issue SHALL be created
- **AND** the batch's `batch-summary.json` and printed summary SHALL be identical to the pre-feature
  behaviour

#### Scenario: Capture enabled but auto-file off still files nothing

- **WHEN** `papercuts.enabled` is `true`, `auto_file` is absent, and papercut events were recorded
- **THEN** the papercuts SHALL still be recorded and reportable
- **AND** no issue SHALL be auto-created

---

### Requirement: Enabled auto-filing SHALL create backlog issues for recurring in-window papercut clusters at run and batch completion

When `papercuts.auto_file` is `true`, the engine SHALL, at run finalization (`run_complete`) and at
the end of a `pipeline queue` batch, cluster the `papercut` events whose timestamps fall inside the
trailing `auto_file_window_hours` window using the same normalization and clustering used by
`pipeline improve`, and SHALL create one GitHub issue for each resulting cluster whose occurrence
count meets or exceeds `auto_file_min_occurrences`. Clusters below the threshold SHALL be reported in
the run/batch output but SHALL NOT be filed. Auto-filing SHALL require no human invocation of
`pipeline improve --apply`.

#### Scenario: Recurring in-window cluster is filed at run completion

- **WHEN** `papercuts.auto_file` is `true` and a papercut cluster inside the window meets
  `auto_file_min_occurrences` as a run reaches `run_complete`
- **THEN** the engine SHALL create one GitHub issue for that cluster without any human command

#### Scenario: Recurring cluster is filed at queue-batch completion

- **WHEN** `papercuts.auto_file` is `true` and a papercut cluster meets `auto_file_min_occurrences`
  across the runs of a completed `pipeline queue` batch
- **THEN** the engine SHALL create one GitHub issue for that cluster at the end of the batch

#### Scenario: Below-threshold cluster is reported but not filed

- **WHEN** a papercut cluster's in-window occurrence count is below `auto_file_min_occurrences`
- **THEN** no issue SHALL be auto-created for it
- **AND** the cluster SHALL still be visible in the run or batch output

#### Scenario: Out-of-window papercuts do not contribute

- **WHEN** papercut events exist whose timestamps fall outside the trailing
  `auto_file_window_hours` window
- **THEN** those events SHALL NOT count toward any cluster's auto-file occurrence count

---

### Requirement: Auto-filed issues SHALL carry only the `pipeline:backlog` label and SHALL NOT be advanced

Every auto-filed issue SHALL be created with the `pipeline:backlog` label. It SHALL receive no other
label, no assignee, no milestone, and no pipeline stage label; the engine SHALL NOT enqueue it, SHALL
NOT start a pipeline run for it, and SHALL NOT advance it toward `pipeline:ready` or any later stage.

#### Scenario: Auto-filed issue is labelled backlog

- **WHEN** an issue is auto-filed from a papercut cluster
- **THEN** it SHALL carry the `pipeline:backlog` label

#### Scenario: Auto-filed issue carries nothing else

- **WHEN** an auto-filed issue is inspected immediately after creation
- **THEN** it SHALL have no label other than `pipeline:backlog`, no assignee, and no milestone

#### Scenario: Auto-filed issue is not queued or advanced

- **WHEN** an issue has been auto-filed during a run or a queue batch
- **THEN** the engine SHALL NOT start a pipeline run for it, SHALL NOT add it to the current batch,
  and SHALL NOT apply any label that would advance it past `pipeline:backlog`

---

### Requirement: Auto-filed issue bodies SHALL be sanitized and SHALL declare agent-reported provenance

Every auto-filed issue body SHALL contain the papercut evidence detail — the normalized signal, the
occurrence count, the affected run IDs, and at least one excerpt of the agent's message — passed
through the engine's artifact sanitization (secret redaction and injection screening) before the
issue is created. The body SHALL additionally contain an explicit statement that its content is
agent-reported friction, automatically filed by the pipeline, and not human-authored or
human-verified.

#### Scenario: Body carries sanitized evidence detail

- **WHEN** an issue is auto-filed from a papercut cluster
- **THEN** its body SHALL include the cluster's normalized signal, occurrence count, affected run
  IDs, and at least one message excerpt
- **AND** that text SHALL have been secret-redacted and injection-screened before creation

#### Scenario: A secret in a papercut message never reaches the issue body

- **WHEN** a papercut message contains a token matching a recognized secret pattern
- **THEN** the created issue body SHALL contain the redacted form and SHALL NOT contain the raw
  secret

#### Scenario: Body declares agent-reported provenance

- **WHEN** an auto-filed issue body is read
- **THEN** it SHALL explicitly state that the content is agent-reported and automatically filed by
  the pipeline rather than human-authored

---

### Requirement: Auto-filing SHALL apply the same open-issue dedup as `improve --apply`

Before auto-creating an issue for a papercut cluster, the engine SHALL apply the same open-issue
dedup used by `pipeline improve --apply`: it SHALL skip any cluster whose proposed
`[pipeline-improve]` title already matches an open issue in the repository. A cluster skipped by
dedup SHALL be logged as already tracked rather than filed.

#### Scenario: Existing open issue suppresses auto-filing

- **WHEN** a qualifying papercut cluster's proposed title matches an open `[pipeline-improve]` issue
- **THEN** no new issue SHALL be auto-created for that cluster

#### Scenario: Two auto-file triggers do not double-file

- **WHEN** the same qualifying cluster is seen at a run's `run_complete` and again at the end of the
  enclosing queue batch
- **THEN** exactly one issue SHALL exist for that cluster

#### Scenario: Repeated runs do not accumulate duplicates

- **WHEN** several consecutive runs each complete with the same qualifying papercut cluster in window
- **THEN** only the first SHALL file an issue, and the rest SHALL be suppressed by dedup while the
  issue remains open

---

### Requirement: Auto-filing SHALL enforce a per-window rate cap

The engine SHALL file at most `auto_file_max_per_window` auto-filed issues within the trailing
`auto_file_window_hours` window, counted across all runs and batches in the repository rather than
per process. Once the cap is reached, remaining qualifying clusters SHALL be reported as deferred and
SHALL NOT be filed until the window has advanced enough for the count to fall below the cap.

#### Scenario: Filing stops at the cap

- **WHEN** `auto_file_max_per_window` issues have already been auto-filed inside the current window
  and further qualifying clusters exist
- **THEN** no additional issue SHALL be created for that window
- **AND** the remaining qualifying clusters SHALL appear in the output marked as deferred

#### Scenario: Filing resumes once the window advances

- **WHEN** the trailing window has advanced so that the in-window auto-filed count is below the cap
- **THEN** a still-qualifying deferred cluster SHALL become eligible for auto-filing again

#### Scenario: Cap holds across concurrent runs

- **WHEN** several runs of one queue batch complete concurrently with qualifying clusters
- **THEN** the total number of issues auto-filed within the window SHALL NOT exceed
  `auto_file_max_per_window`

---

### Requirement: Auto-filing SHALL never fail a run, a stage, or a batch

The auto-file path SHALL be best-effort and total: any error it encounters — unauthenticated `gh`,
network failure, a throwing issue creation, unreadable run artifacts — SHALL be caught, surfaced as a
non-fatal warning, and swallowed. It SHALL NOT change a run's or batch's exit status, SHALL NOT mark
any stage as failed, SHALL NOT emit a `blocker_set` event, and SHALL NOT prevent `run_complete`,
`summary.json`, or `batch-summary.json` from being written.

#### Scenario: Issue creation failure is non-fatal

- **WHEN** auto-filing is enabled and the GitHub issue-creation call throws
- **THEN** the engine SHALL log a non-fatal warning
- **AND** the run or batch SHALL complete with the same exit status it would have had with
  auto-filing disabled

#### Scenario: Unauthenticated gh does not break the run

- **WHEN** auto-filing is enabled and `gh` is not authenticated
- **THEN** the engine SHALL skip auto-filing with a non-fatal warning
- **AND** SHALL NOT emit a `blocker_set` event and SHALL NOT report any stage as failed

#### Scenario: Finalization artifacts are still written

- **WHEN** the auto-file path fails at run finalization
- **THEN** `run_complete` and `summary.json` SHALL still be written for that run
- **AND** at batch level, `batch-summary.json` SHALL still be written

