## MODIFIED Requirements

### Requirement: A needs-human pipeline blocker SHALL be recorded as a non-terminal hold, never as a run-fatal engine defect

The supervisor SHALL record an attested nonterminal needs-human hold only when a blocked dispatch
carries a current canonical `human-decision-required` diagnostic whose structured blocker kind is
also `human-decision-required` and the shared classifier emits a current `DecisionRequest`,
`CapabilityRequest`, or `AuthorityRequest`. The supervisor SHALL verify that diagnostic against fresh dispatch
evidence before creating or retaining the hold. A `pipeline:blocked` label, a
`blocked_needs_human` outcome without that diagnostic, a missing or
reason-less diagnostic, a plan/output format error, an artifact failure, an exhausted mechanical
attempt, or any co-present stage label SHALL be insufficient authority evidence. Every unattested
case SHALL enter typed engine recovery or Cooling and SHALL NOT emit
`human_intervention`, even when the live issue still carries the product blocked label.
While a genuine typed-input wait exists, the run SHALL continue any schedulable dependency-independent
sibling and preserve every sibling's state. A rejected/crashed dispatch or protocol defect SHALL
remain engine-owned and SHALL follow bounded recovery, then Cooling. It SHALL NOT become a terminal
system stop, ownerless terminal, or human ownership.

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
- **AND** it SHALL create an attested typed-input wait only when the strict authority predicate passes

#### Scenario: An unattested needs-human outcome with a live blocked label remains engine-owned

- **WHEN** per-item execution reports `blocked_needs_human` without a current attested
  human-authority diagnostic
- **AND** a fresh live read shows the issue still carries the product blocked label
- **THEN** the supervisor SHALL classify the missing authority proof as a protocol defect and run
  bounded engine recovery
- **AND** it SHALL create no human hold and emit no `human_intervention`

#### Scenario: Current human-decision diagnostic creates a resumable hold

- **WHEN** a blocked dispatch carries a current canonical `human-decision-required` diagnostic
- **AND** the shared classifier emits a typed request
- **THEN** the supervisor SHALL move the item to a typed-input wait and report
  `hold_outstanding=true`
- **AND** it SHALL retain the candidate and authority evidence needed to validate a later answer

#### Scenario: A genuine engine defect is recovered before terminalization

- **WHEN** a dispatch is rejected, crashes, or reports a protocol defect without authority evidence
- **THEN** the outcome SHALL be classified as an engine-owned diagnostic
- **AND** bounded recovery SHALL run
- **AND** exhaustion SHALL enter Cooling rather than a terminal system stop

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
