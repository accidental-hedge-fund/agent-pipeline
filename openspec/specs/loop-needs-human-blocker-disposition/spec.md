# loop-needs-human-blocker-disposition Specification

## Purpose
TBD - created by archiving change loop-needs-human-blocker-disposition. Update Purpose after archive.
## Requirements
### Requirement: A needs-human pipeline blocker SHALL be recorded as a non-terminal hold, never as a run-fatal engine defect

The supervisor SHALL record an attested nonterminal needs-human hold only when a blocked dispatch
carries a current canonical `human-decision-required` diagnostic whose structured blocker kind is
also `human-decision-required`. The supervisor SHALL verify that diagnostic against fresh dispatch
evidence before creating or retaining the hold. A `pipeline:blocked` label, a
`blocked_needs_human` outcome without that diagnostic, a missing or
reason-less diagnostic, a plan/output format error, an artifact failure, an exhausted mechanical
attempt, or any co-present stage label SHALL be insufficient authority evidence. Every unattested
case SHALL enter typed engine recovery or terminal system failure and SHALL NOT emit
`human_intervention`, even when the live issue still carries the product blocked label.
While a genuine human hold exists, the run SHALL continue any schedulable dependency-independent
sibling and preserve every sibling's state. A rejected/crashed dispatch or protocol defect SHALL
remain engine-owned and SHALL follow bounded recovery before any terminal system stop.

#### Scenario: A plan-review format blocker remains engine-owned

- **WHEN** an item's dispatch reports a missing required output section and the issue is observed
  carrying `pipeline:blocked` without a current `human-decision-required` diagnostic
- **THEN** the supervisor SHALL route the canonical engine-owned diagnostic through bounded recovery
- **AND** it SHALL NOT create a needs-human hold or emit `human_intervention`

#### Scenario: A blocked label co-present with a stage label is not authority

- **WHEN** an item's dispatch reports blocked or failed and live truth carries `pipeline:blocked`
  co-present with another `pipeline:*` stage label but no current human-decision diagnostic
- **THEN** the supervisor SHALL preserve the stage and diagnostic for recovery classification
- **AND** it SHALL NOT create a human hold from either label

#### Scenario: A blocked_needs_human outcome requires authority evidence

- **WHEN** per-item execution reports `blocked_needs_human`
- **THEN** the supervisor SHALL inspect its current canonical diagnostic
- **AND** it SHALL create an attested authority hold only when the strict authority predicate passes

#### Scenario: An unattested needs-human outcome with a live blocked label remains engine-owned

- **WHEN** per-item execution reports `blocked_needs_human` without a current attested
  human-authority diagnostic
- **AND** a fresh live read shows the issue still carries the product blocked label
- **THEN** the supervisor SHALL classify the missing authority proof as a protocol defect and run
  bounded engine recovery
- **AND** it SHALL create no human hold and emit no `human_intervention`

#### Scenario: Current human-decision diagnostic creates a resumable hold

- **WHEN** a blocked dispatch carries a current canonical `human-decision-required` diagnostic
- **THEN** the supervisor SHALL move the item to a `paused` or `waiting` hold and report
  `hold_outstanding=true`
- **AND** it SHALL retain the candidate and authority evidence needed to validate a later answer

#### Scenario: A genuine engine defect is recovered before terminalization

- **WHEN** a dispatch is rejected, crashes, or reports a protocol defect without authority evidence
- **THEN** the outcome SHALL be classified as an engine-owned diagnostic
- **AND** bounded recovery SHALL run before any terminal system stop

#### Scenario: A ready sibling survives a genuine human hold

- **WHEN** a run holds one item on current human-authority evidence while a sibling is already
  `ready`
- **THEN** the ready sibling's state SHALL be preserved unchanged
- **AND** the hold SHALL not be reclassified as an engine defect

#### Scenario: A human hold with a schedulable sibling continues the run

- **WHEN** a run holds one item on current human-authority evidence while a dependency-independent
  sibling remains schedulable
- **THEN** the run SHALL continue dispatching the sibling
- **AND** it SHALL revalidate the held item's authority evidence on later cycles

### Requirement: A terminal run stop SHALL disclose every outstanding ready-to-deploy item

A terminal run stop SHALL enumerate every outstanding `ready` item. When the supervisor
records any terminal run stop while one or more items are in the `ready` state
(`pipeline:ready-to-deploy`, awaiting the human merge the pipeline never performs), the
durable stop record SHALL enumerate the ids of those outstanding `ready` items, and the
`pipeline loop` command output SHALL name them. A stop SHALL NEVER be
recorded or reported in a way that silently discards an outstanding ready-to-deploy hold.
The disclosure SHALL be additive metadata on the stop — it SHALL NOT introduce a new
terminal condition, alter the stop reason, or change which items are considered done. When
no item is in the `ready` state at stop time, the enumerated set SHALL be empty and the
existing stop output SHALL be otherwise unchanged.

#### Scenario: A stop names the stranded ready item

- **WHEN** the supervisor records a terminal stop while one item is at `ready` and another
  item caused the stop
- **THEN** the durable stop record SHALL enumerate the `ready` item's id as outstanding
- **AND** the `pipeline loop` output SHALL name that `ready` item

#### Scenario: A stop with no ready item discloses an empty set

- **WHEN** the supervisor records a terminal stop while no item is at `ready`
- **THEN** the stop record's outstanding-ready set SHALL be empty
- **AND** the stop reason and the rest of the stop output SHALL be unchanged from the
  pre-change behavior

#### Scenario: Disclosure does not change the terminal condition

- **WHEN** a stop is recorded alongside one or more outstanding `ready` items
- **THEN** the stop reason and the run's terminal condition SHALL be exactly what they would
  have been without the disclosure
- **AND** the outstanding-ready enumeration SHALL be the only added information

### Requirement: Pure capacity outcomes SHALL NOT become needs-human product holds

The supervisor SHALL classify a pure worktree-capacity admission failure as an engine-owned
`worktree-capacity` diagnostic and SHALL route it to capacity release, wait, or bounded retry. It
SHALL NOT create a product needs-human hold or request a human answer for capacity alone. A genuine
human hold SHALL still require a current canonical `human-decision-required` diagnostic;
neither a blocked label nor stale blocker commentary SHALL satisfy that predicate. Capacity and
authority evidence SHALL be correlated to the current candidate and current blocker application so
stale evidence cannot determine disposition.

#### Scenario: Capacity-only planning failure is not a product needs-human hold

- **WHEN** an item's dispatch fails in planning solely with a worktree-capacity diagnostic
- **AND** no current `human-decision-required` diagnostic exists
- **THEN** the supervisor SHALL apply capacity release, wait, or bounded retry
- **AND** it SHALL NOT create a human hold or emit `human_intervention`

#### Scenario: Genuine authority hold remains distinct from capacity

- **WHEN** an item carries a current canonical `human-decision-required` diagnostic and
  capacity is also tight
- **THEN** the supervisor SHALL preserve the authority hold for the diagnostic's concrete question
- **AND** it SHALL not rewrite the authority reason as capacity admission

#### Scenario: Stale authentic capacity comment does not determine a later block

- **WHEN** an issue has a prior trusted capacity blocker record from an earlier candidate or block
  application
- **AND** the current block has no matching current diagnostic
- **THEN** the supervisor SHALL NOT classify the current block from the stale capacity record
- **AND** it SHALL reconcile current live identity and evidence before choosing a disposition

### Requirement: Production needs-human and human_intervention authority paths SHALL be drift-guarded

The test suite SHALL include a drift guard (source inventory and/or call-graph assertion) that
production transitions into `needs-human` and production emissions of `human_intervention` used
as authority classifiers either (a) invoke the canonical stage-diagnostic authority predicate
helper, or (b) are explicitly listed in the escalation inventory as reporting-only /
non-authority metrics emitters. Review-policy recurrence, surface recurrence, round-ceiling
exhaustion, infrastructure timeouts, and mechanical recovery budget exhaustion SHALL NOT be
accepted as substitutes for the authority predicate.

#### Scenario: Unauthorized needs-human transition fails the guard

- **WHEN** a production path is added that transitions to `needs-human` without the canonical
  authority predicate and without a reporting-only inventory exemption
- **THEN** the authority drift-guard test SHALL fail

#### Scenario: Reporting-only intervention emission may be exempted

- **WHEN** a site emits `human_intervention` solely for metrics and is listed as reporting-only
  in the inventory
- **THEN** the guard SHALL accept the exemption
- **AND** that emission SHALL NOT create or be required to create a human hold

#### Scenario: Recovery exhaustion is not an authority substitute

- **WHEN** mechanical recovery budget is exhausted without current authority evidence
- **THEN** the supervisor path SHALL remain engine-owned
- **AND** the authority drift-guard fixtures SHALL treat a direct human hold from that exhaustion
  as a failing case
)

### Requirement: Durable handoffs SHALL supply the question and resume contract for diagnostic-qualified human holds without inventing authority

When the durable loop or supervisor disposes an item as a human hold under the existing rule that a current canonical `human-decision-required` diagnostic is required for human authority, a corresponding durable human-question handoff SHALL carry the bounded question, authority evidence, and resume target for that hold when create succeeds. The presence of a handoff record alone SHALL NOT authorize a human hold: labels, prose, stale comments, and generic `needs-human` outcomes without a current diagnostic SHALL still fail the authority check. Non-authority `manual_repair` handoffs MAY document repair waits but SHALL NOT satisfy the authority diagnostic gate for product judgment.

#### Scenario: Authority hold with diagnostic creates or links a handoff

- **WHEN** a blocked dispatch carries a current `human-decision-required` diagnostic with key, fingerprint, and reviewed SHA
- **AND** the supervisor disposes the item as a human hold
- **THEN** a durable handoff bound to that evidence SHALL exist or be created
- **AND** the handoff `authority_mode` SHALL be `authority`

#### Scenario: Handoff without diagnostic does not grant authority hold

- **WHEN** only a non-authority handoff or generic `needs-human` label is present
- **AND** no current `human-decision-required` diagnostic exists
- **THEN** the supervisor SHALL NOT treat the item as human-authority disposition solely from the handoff or label
- **AND** engine-owned recovery classification SHALL continue to apply where specified by existing rules

#### Scenario: Manual-repair handoff re-enters normal gates

- **WHEN** an item carries only a non-authority `manual_repair` handoff answer
- **THEN** re-entry SHALL still pass normal repair and review gates
- **AND** the answer SHALL NOT waive review or attestation requirements

