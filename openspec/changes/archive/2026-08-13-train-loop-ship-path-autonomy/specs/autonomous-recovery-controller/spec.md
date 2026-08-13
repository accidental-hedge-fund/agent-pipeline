## ADDED Requirements

### Requirement: Engine-scratch recover SHALL run before implementer repair and SHALL NOT mint a human hold

For recoverable diagnostics that project to engine-owned scratch or the workflow-engine path whose permitted recipe set includes engine-scratch unlink, the production controller SHALL claim and execute the deterministic unlink-engine-scratch recipe (see `engine-scratch-recover`) **before** claiming `repair_pipeline_item` when both appear in the permitted sequence and scratch-only evidence is current. Successful mechanical scratch recovery SHALL re-enter normal whole-item execution and SHALL NOT create a human hold or emit `human_intervention` solely for that recover. Exhaustion of the scratch recipe with remaining product dirt or a non-scratch engine defect SHALL follow existing engine-owned terminal failure rules without inventing product-judgment authority.

#### Scenario: Scratch-only path never selects implementer repair first

- **WHEN** current evidence is engine-scratch-only and both unlink-engine-scratch and `repair_pipeline_item` are configured for the class
- **THEN** the controller SHALL start unlink-engine-scratch before any implementer repair claim
- **AND** a successful unlink with clean product porcelain SHALL resume without a human hold

#### Scenario: Human-decision-required still creates a hold

- **WHEN** fresh dispatch evidence carries a valid `human-decision-required` diagnostic with matching authority evidence at the current candidate SHA
- **THEN** the controller SHALL still create a resumable human hold per existing human-hold rules
- **AND** engine-scratch unlink SHALL NOT fire for that authority evidence alone
