## ADDED Requirements

### Requirement: Plan-revision acknowledgement verification SHALL consume the shared stage-output contract layer

Plan-revision acknowledgement verification SHALL use the versioned stage-output contract
`plan-revision.ack@1` (or a successor) and the shared format-repair policy for the
machine-checkable `## Feedback Incorporated` section. Prompt template wording requirements in
this capability remain in force and SHALL stay drift-guarded; this requirement does not replace
those prompt constraints. Pure shape failures after the shared repair budget is exhausted
SHALL terminal as `harness-contract` under `pipeline/stage-diagnostic@1` rather than solely as
product `needs-human`.

#### Scenario: Prompt contract and validation contract both apply

- **WHEN** a plan-revision round runs
- **THEN** the rendered prompt SHALL still state the unfenced, single-header, line-start
  acknowledgement constraints required by this capability
- **AND** the resulting stdout SHALL be validated through `plan-revision.ack@1` before the
  revised plan is posted

#### Scenario: Exhausted shape failure is not product needs-human alone

- **WHEN** plan-revision stdout fails acknowledgement validation after shared repair exhaustion
- **THEN** the terminal diagnostic reason SHALL be `harness-contract`
- **AND** SHALL NOT be solely `needs-human` for that pure shape failure
