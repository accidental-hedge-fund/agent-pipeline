## ADDED Requirements

### Requirement: implementation-ci recovery for no-commits SHALL try shared HEAD goal satisfaction first

When a blocked item’s diagnostic projects `no-commits` (or an equivalent implementation-outcome block) into the `implementation-ci` recovery class, the autonomous recovery controller’s policy for that class SHALL include a **deterministic first recipe** that invokes the shared `noop-advance-contract` evaluation with the **current stage’s** goal checks against the claimed HEAD. When evaluation returns **advance**, the controller SHALL record attested evidence, redispatch or continue normal execution as appropriate, and SHALL **not** charge model-repair (`repair_pipeline_item` or equivalent) budget for that successful recipe. When evaluation returns **escalate** or goal checks cannot run, the controller SHALL proceed to the next configured recipe for the class (including model repair when permitted) or typed exhaustion — fail closed. The recipe SHALL NOT add a recovery-only marker that bypasses normal product gates, and SHALL use the same verifier as normal stage execution (no parallel private satisfaction algorithm).

#### Scenario: First recipe is goal satisfaction for no-commits implementation-ci

- **WHEN** fresh reconciliation classifies a `no-commits` block as `implementation-ci` with recovery budget remaining
- **THEN** the controller SHALL claim and execute the shared goal-satisfaction recipe before model-repair recipes for that class
- **AND** the recipe SHALL call the shared noop-advance evaluation used by stage execution

#### Scenario: Satisfied HEAD advances without model-repair budget

- **WHEN** the goal-satisfaction recipe runs and the shared evaluation returns **advance**
- **THEN** the controller SHALL record attested evidence and continue/redispatch
- **AND** SHALL NOT decrement model-repair budget for that successful goal-satisfaction recipe

#### Scenario: Unsatisfied HEAD does not falsely clear the block

- **WHEN** the goal-satisfaction recipe runs and the shared evaluation returns **escalate**
- **THEN** the controller SHALL NOT mark the item repaired solely by this recipe
- **AND** SHALL advance to the next configured recipe or exhaust fail-closed under existing policy
- **AND** SHALL NOT bypass format, test, CI, OpenSpec, or review gates on subsequent paths
