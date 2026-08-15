## ADDED Requirements

### Requirement: Progressive-planning depth routing SHALL use staged policy lifecycle and SHALL NOT start enforcing without evidence lineage

When progressive-planning automated depth routing is represented as a staged policy, the engine SHALL subject it to the same closed lifecycle states (`draft`, `observe`, `required`, `enforcing`, `retired`) and validated promotion lineage as other staged policies. Research and measurement phases SHALL correspond to non-enforcing states (`draft` and/or `observe`). Config declaration of progressive-planning automation as `enforcing` without a fully validated lineage chain into `enforcing` (including non-empty `evidence_refs` on observation-gated promotions that reference offline evaluation or observe-window evidence) SHALL be rejected.

The research package for risk-calibrated progressive planning SHALL NOT, by itself, install an `enforcing` progressive-planning policy or a bypass switch that selects `planning_depth` outside staged-policy rules.

#### Scenario: draft or observe is valid without enforcement

- **WHEN** progressive-planning policy is declared or documented in `draft` or `observe` state with valid lineage into that state
- **THEN** validation SHALL accept the non-enforcing state
- **AND** advance SHALL NOT auto-select `planning_depth` solely from that policy while state is `draft`

#### Scenario: enforcing without evidence refs is rejected

- **WHEN** progressive-planning policy is declared `enforcing`
- **AND** lineage lacks non-empty `evidence_refs` on the observation-gated promotion path required by stage-policy-lifecycle
- **THEN** config validation SHALL fail
- **AND** the policy SHALL NOT be exposed as effective `enforcing`

#### Scenario: research change does not install enforcing

- **WHEN** only the risk-calibrated progressive-planning research change is applied
- **THEN** no staged progressive-planning policy SHALL become effective `enforcing` as a sole result of that change
- **AND** existing planning depth selection behavior SHALL remain the runtime default
