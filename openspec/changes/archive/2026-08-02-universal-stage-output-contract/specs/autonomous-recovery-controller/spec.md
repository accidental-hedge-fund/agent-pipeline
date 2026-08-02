## ADDED Requirements

### Requirement: Exhausted shared format-repair SHALL surface harness-contract to recovery projection

The advance path SHALL emit a `pipeline/stage-diagnostic@1` diagnostic whose reason code is
`harness-contract` (or an exhaustive pure projection of that code through the closed
vocabulary) when a model-executed stage exhausts the shared stage-output format-repair budget
on a pure shape failure. The durable-loop / autonomous-recovery projection SHALL classify that
diagnostic as engine-owned (not `human_authority` / product hold) consistent with the existing
capture and output-contract → harness-contract mapping. Free-form blocker prose alone SHALL NOT
be the primary classification signal.

#### Scenario: Stage-emitted harness-contract after repair exhaustion projects engine-owned

- **WHEN** plan-revision or OpenSpec singularity blocks after shared format-repair exhaustion
  with diagnostic reason `harness-contract`
- **THEN** the recovery projection SHALL treat the failure as engine-owned
- **AND** SHALL NOT create a human-authority hold solely from that pure shape failure

#### Scenario: Classification does not require prose scraping

- **WHEN** the diagnostic carries structured reason `harness-contract` and blocker detail
- **THEN** projection SHALL use the structured reason code
- **AND** SHALL NOT require matching free-form reason text as the primary signal
