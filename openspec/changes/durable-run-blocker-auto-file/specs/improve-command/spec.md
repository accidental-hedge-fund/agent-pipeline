## ADDED Requirements

### Requirement: improve command clusters durable-run blockers as a category

The `pipeline improve` analyzer SHALL support a `durable-run-blocker` cluster
category that reads typed durable-run blocker records — each item's
`blocked_theme` (a durable blocker class), its `evidence_fingerprint`, and any
terminal run-stop record — from the in-repo durable-run ledgers under the loop
state home, a distinct evidence source from the `.agent-pipeline/runs/` events
the other categories read. Each `durable-run-blocker` cluster SHALL be keyed on
the pair `(blocker class, evidence fingerprint)` rather than on normalized
free-text prose, and SHALL record: the category, the theme (blocker class) as its
signal, the occurrence count, every affected run id, the affected item ids, the
evidence fingerprint, whether any occurrence was a terminal run stop, and an
evidence excerpt truncated to ≤ 200 characters. The durable-run read SHALL be
read-only: it SHALL acquire no run lock, write no ledger, and append no event.

#### Scenario: Repeated durable-run blockers cluster by class and fingerprint

- **WHEN** two or more durable-run ledgers record a blocker with the same blocker
  class and the same `evidence_fingerprint`
- **THEN** those blockers SHALL be grouped into a single `durable-run-blocker`
  cluster keyed on that `(class, fingerprint)` pair
- **AND** the cluster SHALL list every affected run id, the affected item ids, the
  evidence fingerprint, and an evidence excerpt
- **AND** the cluster's identity SHALL NOT depend on the free-text blocker
  evidence prose

#### Scenario: Terminal stop is recorded on the cluster

- **WHEN** a durable-run ledger recorded a terminal run-stop attributable to a
  blocker
- **THEN** the `durable-run-blocker` cluster for that `(class, fingerprint)` SHALL
  record that a terminal stop occurred

#### Scenario: Durable-run read is side-effect-free

- **WHEN** the analyzer reads durable-run ledgers to build `durable-run-blocker`
  clusters
- **THEN** it SHALL NOT acquire any run lock, write any ledger, or append any
  event
- **AND** a single unreadable or partial ledger SHALL be skipped rather than
  aborting the report

### Requirement: durable-run-blocker report suggests a milestone without assigning one

The dry-run `pipeline improve` report SHALL list, for each `durable-run-blocker`
cluster, the evidence fingerprint, the runs affected, the theme (blocker class),
and a suggested milestone derived deterministically from the blocker class. The
suggested milestone SHALL be advisory text only; neither the report, the
`--apply` path, nor the auto-file path SHALL assign a milestone to any issue.

#### Scenario: Report includes a suggested milestone

- **WHEN** `pipeline improve` reports a `durable-run-blocker` cluster
- **THEN** the report SHALL include the cluster's fingerprint, affected runs,
  theme, and a suggested milestone

#### Scenario: No milestone is ever assigned

- **WHEN** a `durable-run-blocker` issue is filed by `--apply` or by the auto-file
  path
- **THEN** the created issue SHALL carry no milestone
- **AND** the suggested milestone SHALL appear only as advisory text in the report
  and issue body
