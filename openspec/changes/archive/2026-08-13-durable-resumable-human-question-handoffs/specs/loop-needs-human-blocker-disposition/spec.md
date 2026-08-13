## ADDED Requirements

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
