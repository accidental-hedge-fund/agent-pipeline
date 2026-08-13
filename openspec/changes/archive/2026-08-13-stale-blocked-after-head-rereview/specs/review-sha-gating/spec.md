## ADDED Requirements

### Requirement: Enter-path stale-block resume SHALL use the same supersession classification as the SHA gate

When the pipeline decides whether a leftover `pipeline:blocked` label is stale because PR HEAD moved past the blocking `reviewed-sha`, it SHALL use the same non-pipeline-internal supersession classification that the pre-merge review-SHA gate uses to decide whether a recorded verdict is current, superseded, or unclassifiable. Pipeline-internal-only tip advances SHALL remain non-invalidating for clean approval reuse (#98). A residual same-head blocking key set SHALL continue to hold the gate when `reviewed-sha` equals the live head. This requirement does not invent overrides and does not weaken security residual blocking on a current head.

#### Scenario: Shared supersession definition for resume and gate

- **WHEN** enter-path stale-block resume classifies commits between blocking `reviewed-sha` S and PR HEAD H
- **THEN** it SHALL treat non-pipeline-internal commits as superseding the blocking verdict under the same rules as the pre-merge SHA gate
- **AND** SHALL treat pipeline-internal-only ranges as non-superseding for verdict-reuse purposes (#98)

#### Scenario: Same-head residual keys still hold

- **WHEN** the live PR head equals the blocking `reviewed-sha` and residual blocking keys remain un-overridden
- **THEN** the SHA gate and enter-path resume SHALL both keep residual authority at that head
- **AND** SHALL NOT clear the block solely as a stale resume
