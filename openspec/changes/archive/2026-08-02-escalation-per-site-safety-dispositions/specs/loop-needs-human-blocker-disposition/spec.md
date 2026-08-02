## ADDED Requirements

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