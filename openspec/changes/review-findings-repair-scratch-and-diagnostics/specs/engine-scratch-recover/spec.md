## ADDED Requirements

### Requirement: Review-findings recovery SHALL prep-unlink engine scratch before implementer repair

For durable class `review-findings`, the autonomous recovery recipe set SHALL include deterministic action `unlink_engine_scratch` ordered **ahead of** `repair_pipeline_item` in the default recovery policy. When that action runs under `review-findings` and porcelain lists engine-known scratch under the shared non-product set (including at least `artifacts/challenge-response-*.json`) with empty product dirt, it SHALL remove or restore only those engine-known scratch paths so a later `repair_pipeline_item` claim observes a product-clean tree. That preparatory unlink SHALL NOT auto-commit scratch into the product tree, SHALL NOT invoke the implementer, and SHALL NOT clear `pipeline:blocked` solely as a successful findings recovery while blocking review findings still apply at the same candidate. When no engine-known scratch is present, the action SHALL fail closed as not-applicable so the next configured recipe (`repair_pipeline_item`) can run. Product dirt after classification SHALL still fail closed. This requirement does not change the terminal scratch-only recover path for `workflow-engine-defect` (unlink, clear blocked when scratch-only, no harness round).

#### Scenario: Findings class policy places unlink before repair

- **WHEN** the default permitted recipe sequence for `review-findings` is inspected under test
- **THEN** `unlink_engine_scratch` SHALL appear before `repair_pipeline_item`
- **AND** a unit test SHALL fail if implementer repair is the only default recipe or is ordered first

#### Scenario: Scratch present under findings is unlinked as prep

- **WHEN** recovery claims `unlink_engine_scratch` for class `review-findings`
- **AND** porcelain is engine-scratch-only under the shared classifier (for example `?? artifacts/challenge-response-N.json`)
- **THEN** the action SHALL unlink or restore those engine-known scratch paths
- **AND** SHALL NOT stage or commit the scratch into the product tree
- **AND** SHALL NOT treat the attempt as successful substantive findings recovery that clears the findings block solely via unlink
- **AND** a following `repair_pipeline_item` claim SHALL see no remaining engine-known scratch from that set

#### Scenario: No scratch under findings falls through to repair

- **WHEN** recovery claims `unlink_engine_scratch` for class `review-findings`
- **AND** porcelain has no engine-known scratch paths
- **THEN** the action SHALL NOT clear the findings block as recovered
- **AND** SHALL return a not-applicable / try-next-recipe failure so `repair_pipeline_item` remains reachable

#### Scenario: Workflow-engine-defect terminal scratch recover is unchanged

- **WHEN** a recoverable diagnostic projects to engine-scratch / `workflow-engine-defect` with scratch-only porcelain
- **THEN** the controller SHALL still claim and execute `unlink_engine_scratch` before `repair_pipeline_item`
- **AND** after unlink, when no product dirt remains, it SHALL clear `pipeline:blocked` if present for that scratch cause
- **AND** it SHALL NOT invoke `repair_pipeline_item` for that attempt when unlink alone clears the scratch-only block
