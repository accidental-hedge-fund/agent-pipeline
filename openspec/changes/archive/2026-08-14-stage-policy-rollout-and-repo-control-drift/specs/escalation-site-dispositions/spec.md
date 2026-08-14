## ADDED Requirements

### Requirement: Fail-closed repository-control drift parks SHALL appear in the escalation inventory

When the engine parks or blocks readiness because an `enforcing` control with `risk_class: fail_closed` is not `in_sync` (outcomes `drifted`, `unavailable`, or `unknown`), that production escalation site SHALL be present in the machine-readable escalation-site inventory with disposition `deliberately-fail-closed`. The site SHALL use a typed reason projection from the closed drift reason set (including at least codes for required-check drift, branch-protection drift, ruleset drift, pipeline-gate drift, collector drift, live unavailable, and unsupported control). The site SHALL NOT perform automatic forge remediation or transient retry that mutates repository controls before escalating.

#### Scenario: Fail-closed drift park is inventoried

- **WHEN** the escalation-site inventory is loaded after this capability ships
- **THEN** it SHALL include an entry for fail-closed repository-control drift readiness parks
- **AND** that entry’s disposition SHALL be `deliberately-fail-closed`

#### Scenario: Observation-only drift is not an escalation site

- **WHEN** drift is recorded for a policy in `observe` or for `risk_class: observation`
- **THEN** the engine SHALL NOT require an escalation-inventory park solely for that observation record
- **AND** SHALL NOT invent automatic remediation

#### Scenario: Drift park does not auto-remediate forge settings

- **WHEN** a fail-closed drift park site is triggered
- **THEN** the site SHALL escalate with a typed drift reason
- **AND** SHALL NOT recreate rulesets, rewrite branch protection, or force-add required checks as part of the escalation path
