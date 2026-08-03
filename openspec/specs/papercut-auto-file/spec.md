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

Every auto-filed issue SHALL be created with the `pipeline:backlog` label. Non-engine-class
auto-filed issues SHALL receive no other label. Engine-class auto-filed issues (clusters whose
signal or typed disposition projects to the FRG/engine-class taxonomy, including
`workflow-engine-defect`) SHALL additionally receive the `bug` label and the stable
`pipeline:engine-class` marker label so release open-soak-defect fallback queries and operators can
index them; those two labels are index markers only and SHALL NOT be treated as pipeline stage
labels. No auto-filed issue SHALL receive an assignee, milestone, or pipeline stage label; the
engine SHALL NOT enqueue it, SHALL NOT start a pipeline run for it, and SHALL NOT advance it toward
`pipeline:ready` or any later stage.

#### Scenario: Auto-filed issue is labelled backlog

- **WHEN** an issue is auto-filed from a papercut cluster
- **THEN** it SHALL carry the `pipeline:backlog` label

#### Scenario: Non-engine-class auto-filed issue carries nothing else

- **WHEN** an auto-filed issue is created from a non-engine-class papercut cluster
- **AND** it is inspected immediately after creation
- **THEN** it SHALL have no label other than `pipeline:backlog`, no assignee, and no milestone

#### Scenario: Engine-class auto-filed issue carries bug and engine-class marker

- **WHEN** an auto-filed issue is created from an engine-class papercut cluster
- **THEN** it SHALL carry `pipeline:backlog`, `bug`, and `pipeline:engine-class`
- **AND** it SHALL have no assignee, no milestone, and no pipeline stage label

#### Scenario: Auto-filed issue is not queued or advanced

- **WHEN** an issue has been auto-filed during a run or a queue batch
- **THEN** the engine SHALL NOT start a pipeline run for it, SHALL NOT add it to the current batch,
  and SHALL NOT apply any label that would advance it past `pipeline:backlog`

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

The engine SHALL file at most `papercuts.auto_file_max_per_window` open papercut-auto-filed
issues within the trailing `papercuts.auto_file_window_hours` window, counted across all runs
and batches in the repository rather than per process. An issue SHALL count toward this cap
only when it is open, carries the `pipeline:backlog` label, was created inside the trailing
window, and its body includes the papercut auto-file provenance marker. Issues auto-filed by
other categories (correction, durable-run-blocker), human-managed backlog issues, and
`pipeline improve --apply` issues SHALL NOT count toward the papercut cap. Once the cap is
reached, remaining qualifying papercut clusters SHALL be reported as deferred and SHALL NOT be
filed until the window has advanced enough for the papercut-scoped count to fall below the cap.

#### Scenario: Filing stops at the papercut cap

- **WHEN** `papercuts.auto_file_max_per_window` open papercut-auto-filed issues already exist
  inside the current papercut window and further qualifying papercut clusters exist
- **THEN** no additional papercut issue SHALL be created for that window
- **AND** the remaining qualifying papercut clusters SHALL appear in the output marked as deferred

#### Scenario: Filing resumes once the window advances

- **WHEN** the trailing papercut window has advanced so that the in-window open
  papercut-auto-filed count is below the cap
- **THEN** a still-qualifying deferred papercut cluster SHALL become eligible for auto-filing again

#### Scenario: Cap holds across concurrent runs for the papercut category

- **WHEN** several runs of one queue batch complete concurrently with qualifying papercut clusters
- **THEN** the total number of open papercut-auto-filed issues within the papercut window SHALL
  NOT exceed `papercuts.auto_file_max_per_window`

#### Scenario: Other categories do not consume the papercut cap

- **WHEN** open in-window correction-auto-filed or durable-run-blocker-auto-filed issues exist
  and the open in-window papercut-auto-filed count is still below
  `papercuts.auto_file_max_per_window`
- **THEN** a qualifying papercut cluster SHALL still be eligible for auto-filing

#### Scenario: Unmarked backlog issues do not consume the papercut cap

- **WHEN** open in-window `pipeline:backlog` issues exist without the papercut auto-file
  provenance marker (including human-filed or `improve --apply` issues)
- **THEN** those issues SHALL NOT count toward `papercuts.auto_file_max_per_window`

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

### Requirement: Auto-file dedup SHALL converge to a single open issue per cluster across distinct hosts

Auto-filing SHALL guarantee that a qualifying papercut cluster results in at most one open
auto-filed issue **across pipeline processes running on different hosts**, not only within a single
host's `withLock` critical section. Because the host-local `/tmp` lock provides no cross-host mutual
exclusion, the engine SHALL treat GitHub-authored issue state as the shared source of truth: after
creating an auto-filed issue, the engine SHALL re-read the improve-issue list, and when the created
title maps to more than one open issue, SHALL keep the lowest-numbered open issue and close the
remaining duplicates with a comment that references the surviving issue. The lowest-numbered-survivor
rule SHALL be deterministic so that two hosts reconciling the same duplicate select the same survivor.
This reconciliation SHALL be best-effort and total: any failure SHALL be caught, logged as a
non-fatal warning, and SHALL NOT fail a run, stage, or batch.

#### Scenario: Two hosts filing the same cluster converge to one open issue

- **WHEN** two pipeline processes on distinct hosts each pass the pre-create dedup check for the same
  qualifying cluster and both create an issue with the same title
- **THEN** after read-back reconciliation exactly one issue for that title SHALL remain open
- **AND** the surviving issue SHALL be the lowest-numbered of the duplicates
- **AND** the closed duplicate SHALL carry a comment referencing the surviving issue

#### Scenario: Single-host run performs no reconciliation

- **WHEN** only one host auto-files and no duplicate title exists after a create
- **THEN** the engine SHALL close no issue
- **AND** the run's output and artifacts SHALL be identical to the behaviour before cross-host
  reconciliation existed

#### Scenario: Reconciliation failure is non-fatal

- **WHEN** the read-back list or the duplicate-close call throws during reconciliation
- **THEN** the engine SHALL log a non-fatal warning and leave the duplicate for a later trigger to
  reconcile
- **AND** the run or batch SHALL complete with the same exit status it would have had with
  auto-filing disabled

---

### Requirement: Auto-file rate cap SHALL be enforced against GitHub-authored issue state to bound cross-host overshoot

The papercut per-window rate cap SHALL be enforced so that the total number of open
**papercut-auto-filed** issues within the trailing `papercuts.auto_file_window_hours` window does
not exceed `papercuts.auto_file_max_per_window` **across hosts**, not merely per host. The engine
SHALL derive the in-window papercut-auto-filed count from GitHub-authored issue state at or
immediately before each create — rather than solely from a single up-front host-local snapshot
decremented in memory — so that a papercut issue already created by another host is counted
before this host files. Membership in that count SHALL use the same predicate as post-create
rate-cap reconciliation: open, `pipeline:backlog`, papercut provenance marker, created inside
the window. Because two hosts can both pass this pre-create check before either create lands —
including for **different** papercut cluster titles, which the duplicate-title reconciliation
above cannot detect — the post-create reconciliation SHALL also recompute the in-window open
papercut-auto-filed set from a fresh read-back and close every papercut-auto-filed issue past the
lowest-numbered `papercuts.auto_file_max_per_window` survivors, ordered by issue number ascending.
Rate-cap reconciliation SHALL NOT close open issues that lack the papercut provenance marker
(including other auto-file categories). This rate-cap reconciliation SHALL use the same
deterministic lowest-numbered-survivor rule as the duplicate-title reconciliation so that two
hosts reconciling independently — even against snapshots taken at different times — converge on
the same surviving papercut set once every involved host's post-create reconciliation has run.

#### Scenario: Concurrent hosts near the papercut cap do not overshoot

- **WHEN** two pipeline processes on distinct hosts auto-file papercut clusters concurrently
  while the in-window open papercut-auto-filed count is at or near
  `papercuts.auto_file_max_per_window`
- **THEN** after reconciliation the number of open papercut-auto-filed issues in the window
  SHALL NOT exceed `papercuts.auto_file_max_per_window`

#### Scenario: An issue filed by another host counts toward the papercut cap

- **WHEN** host B computes its remaining papercut cap after host A has already created an
  in-window open papercut-auto-filed issue for a different papercut cluster
- **THEN** host B's papercut cap count SHALL include host A's papercut issue as read from GitHub
- **AND** host B SHALL stop filing papercut issues once the GitHub-authored in-window
  papercut-auto-filed count reaches the papercut cap

#### Scenario: Concurrent hosts filing different papercut titles past the cap converge after reconciliation

- **WHEN** two pipeline processes on distinct hosts each pass the pre-create papercut cap check
  against the same stale, pre-create snapshot — because neither host's create is visible to the
  other's check yet — and each creates a papercut issue for a **different** cluster title,
  together exceeding `papercuts.auto_file_max_per_window`
- **THEN** each host's post-create reconciliation SHALL recompute the in-window open
  papercut-auto-filed set and close every papercut-auto-filed issue past the lowest-numbered
  `papercuts.auto_file_max_per_window` survivors
- **AND** once every involved host's reconciliation has run, the number of open
  papercut-auto-filed issues in the window SHALL NOT exceed `papercuts.auto_file_max_per_window`
- **AND** open auto-filed issues of other categories SHALL remain open solely because of this
  papercut rate-cap reconciliation

### Requirement: Pre-create and post-create papercut rate-cap predicates SHALL be identical

The papercut rate-cap membership rule SHALL be identical for pre-create counting and for
post-create rate-cap overflow selection. An issue counts under both sites only when it is open,
carries `pipeline:backlog`, includes the papercut provenance marker, and was created inside the
window. The engine SHALL NOT use an unlabeled backlog count for pre-create while using a
marker-filtered set for reconcile, or any other split of open/closed, marker, or window rules
between the two sites.

#### Scenario: Pre-create and reconcile agree on membership

- **WHEN** the same GitHub-authored issue list is evaluated for papercut pre-create cap counting
  and for papercut post-create rate-cap reconciliation
- **THEN** both evaluations SHALL include exactly the same set of issues under the open,
  backlog-label, papercut-marker, and in-window created-at rules

