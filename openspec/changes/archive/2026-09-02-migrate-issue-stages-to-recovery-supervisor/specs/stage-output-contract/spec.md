## ADDED Requirements

### Requirement: Contract-failing harness output SHALL be an owned operation observation

When central validation returns not-ok after the shared format-repair policy, the owning stage adapter SHALL emit a typed operation observation. The adapter SHALL NOT perform the gated side effect. The adapter SHALL NOT declare the Logical Operation complete, cancelled, or human-owned solely because the output failed the contract. RecoverySupervisor SHALL own treatment or Cooling.

#### Scenario: Unparseable review verdict stays owned

- **WHEN** reviewer stdout cannot be parsed into a schema-satisfying verdict under `review.verdict@1` after repair budget exhaustion
- **THEN** the failure SHALL be classified as an output-contract observation
- **AND** SHALL NOT be recorded as a successful verdict with zero findings
- **AND** the Logical Operation SHALL remain owned

#### Scenario: Failed plan-revision ack stays owned

- **WHEN** plan-revision stdout fails `plan-revision.ack@1` after repair budget exhaustion
- **THEN** the pipeline SHALL NOT post the revised plan as an issue comment
- **AND** the adapter SHALL emit an observation
- **AND** SHALL NOT mark the Logical Operation complete or cancelled
