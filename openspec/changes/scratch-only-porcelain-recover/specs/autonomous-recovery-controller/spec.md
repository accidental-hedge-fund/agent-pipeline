## MODIFIED Requirements

### Requirement: Engine-scratch recover SHALL run before implementer repair and SHALL NOT mint a human hold

For recoverable diagnostics that project to engine-owned scratch or the `workflow-engine-defect` path, the default recovery policy SHALL list the deterministic action `unlink_engine_scratch` (see `engine-scratch-recover`) **before** `repair_pipeline_item` when both appear in the permitted sequence. The production controller SHALL claim and execute `unlink_engine_scratch` before claiming `repair_pipeline_item` when scratch-only evidence is current. Successful mechanical scratch recovery SHALL clear `pipeline:blocked` when the block was scratch-only, re-enter normal whole-item execution for the current stage, and SHALL NOT create a human hold or emit `human_intervention` solely for that recover. Exhaustion of the scratch recipe with remaining product dirt or a non-scratch engine defect SHALL follow existing engine-owned terminal failure rules without inventing product-judgment authority. Residual blocks that remain on the engine-scratch / factory-defect path SHALL stay in `workflow-engine-defect` (recover), not `human-decision-required`.

#### Scenario: Scratch-only path never selects implementer repair first

- **WHEN** current evidence is engine-scratch-only and both `unlink_engine_scratch` and `repair_pipeline_item` are configured for the class
- **THEN** the controller SHALL start `unlink_engine_scratch` before any implementer repair claim
- **AND** a successful unlink with clean product porcelain SHALL clear the mechanical block when present and resume without a human hold
- **AND** SHALL NOT invoke `repair_pipeline_item` for that attempt

#### Scenario: Default workflow-engine-defect policy orders unlink first

- **WHEN** the default recovery policy entry for `workflow-engine-defect` is inspected under test
- **THEN** `unlink_engine_scratch` SHALL appear before `repair_pipeline_item` in the recipes list
- **AND** a unit test SHALL fail if the default order selects implementer repair first for that class

#### Scenario: Human-decision-required still creates a hold

- **WHEN** fresh dispatch evidence carries a valid `human-decision-required` diagnostic with matching authority evidence at the current candidate SHA
- **THEN** the controller SHALL still create a resumable human hold per existing human-hold rules
- **AND** `unlink_engine_scratch` SHALL NOT fire for that authority evidence alone
