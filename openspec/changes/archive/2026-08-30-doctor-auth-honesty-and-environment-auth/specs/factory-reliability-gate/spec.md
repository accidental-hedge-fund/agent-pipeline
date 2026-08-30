## ADDED Requirements

### Requirement: environment-auth durable themes SHALL score as product-class, not engine-class

The FRG blocker taxonomy SHALL treat durable theme `environment-auth` as `product-class`. A scored pack item whose blocker theme is `environment-auth` SHALL increment product-class counts and SHALL NOT increment `engine_class_count`. The taxonomy SHALL NOT treat that theme as `workflow-engine-defect` or `engine-class`. This scenario is a classification honesty check. The live FRG pack SHALL NOT require a revoked third-party credential as a pack item.

#### Scenario: classifyFrgBlocker maps environment-auth to product-class

- **WHEN** FRG blocker taxonomy is applied to theme `environment-auth`
- **THEN** the result SHALL be `product-class`
- **AND** SHALL NOT be `engine-class` or `human-authority`

#### Scenario: Pack item themed environment-auth does not inflate engine-class rate

- **WHEN** a scored pack has one processed item blocked with theme `environment-auth` and no engine-class items
- **THEN** `engine_class_count` SHALL be 0
- **AND** the product-class count SHALL include that item
- **AND** `engine_class_rate` SHALL be 0

#### Scenario: Mis-themed credential failure is the regression the scenario bites

- **WHEN** the same item is instead themed `workflow-engine-defect`
- **THEN** that item SHALL count as engine-class
- **AND** a unit test SHALL fail if classifier fixtures that represent harness 401 / `refresh_token_invalidated` would produce that engine-class theme
