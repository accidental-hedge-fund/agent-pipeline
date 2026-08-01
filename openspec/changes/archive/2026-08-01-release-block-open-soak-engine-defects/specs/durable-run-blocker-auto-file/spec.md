## MODIFIED Requirements

### Requirement: Auto-filed durable-run-blocker issues SHALL be sanitized, backlog-only, and carry ledger reproduction context

Every auto-filed durable-run-blocker issue SHALL carry the `pipeline:backlog` label, no assignee,
no milestone, and no pipeline stage label; the engine SHALL NOT enqueue it or advance it.
Non-engine-class filings SHALL carry no labels other than `pipeline:backlog`. Engine-class filings
(blocker class `workflow-engine-defect` or other FRG engine-class taxonomy members as recorded on
the cluster) SHALL additionally carry the `bug` label and the stable `pipeline:engine-class` marker
label as operator/release indexes only. Its body SHALL contain the cluster's reproduction context —
the affected run ids, item ids, blocker class, evidence fingerprint, and an evidence excerpt drawn
from the ledger — passed through the store's existing secret redaction and injection screening
before creation, and SHALL explicitly state that its content is agent/pipeline-reported,
automatically filed by the pipeline, and not human-authored or human-verified.

#### Scenario: Auto-filed non-engine-class issue is backlog-only

- **WHEN** an issue is auto-filed from a durable-run-blocker cluster whose class is not engine-class
- **THEN** it SHALL carry only the `pipeline:backlog` label and SHALL NOT be queued or advanced
- **AND** it SHALL carry no milestone and no assignee

#### Scenario: Auto-filed engine-class issue carries bug and engine-class marker

- **WHEN** an issue is auto-filed from a durable-run-blocker cluster with class
  `workflow-engine-defect` (or another engine-class member)
- **THEN** it SHALL carry `pipeline:backlog`, `bug`, and `pipeline:engine-class`
- **AND** it SHALL NOT be queued or advanced
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
